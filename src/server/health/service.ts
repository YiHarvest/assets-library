import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "@/server/config";
import { getDatabase } from "@/server/db/singleton";
import {
  readWorkerHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_MS,
} from "@/server/health/worker-heartbeat";
import { SceneDetectClient } from "@/server/scene/client";
import { createZosObjectStorage } from "@/server/storage/zos";

export type HealthState = "up" | "down" | "disabled";

export interface HealthComponent {
  status: HealthState;
  last_heartbeat_at?: string;
}

export interface HealthReport {
  status: "ok" | "unavailable";
  checked_at: string;
  services: {
    web: HealthComponent;
    worker: HealthComponent;
    mysql: HealthComponent;
    chroma: HealthComponent;
    scene_detect: HealthComponent;
    zos: HealthComponent;
  };
}

interface HealthDependencies {
  now: () => Date;
  worker: (now: Date) => Promise<HealthComponent>;
  mysql: () => Promise<HealthComponent>;
  chroma: () => Promise<HealthComponent>;
  sceneDetect: () => Promise<HealthComponent>;
  zos: () => Promise<HealthComponent>;
}

function shanghaiIso(value: Date) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkWorker(now: Date): Promise<HealthComponent> {
  const heartbeat = await readWorkerHeartbeat();
  if (
    !heartbeat ||
    !processExists(heartbeat.pid) ||
    now.getTime() - heartbeat.updatedAt.getTime() > WORKER_HEARTBEAT_MAX_AGE_MS ||
    heartbeat.updatedAt.getTime() > now.getTime() + WORKER_HEARTBEAT_INTERVAL_TOLERANCE_MS
  ) {
    return { status: "down" };
  }
  return {
    status: "up",
    last_heartbeat_at: shanghaiIso(heartbeat.updatedAt),
  };
}

const WORKER_HEARTBEAT_INTERVAL_TOLERANCE_MS = 5_000;
const TRANSIENT_HEALTH_RETRY_DELAY_MS = 100;

function retryDelay() {
  return new Promise<void>((resolve) =>
    setTimeout(resolve, TRANSIENT_HEALTH_RETRY_DELAY_MS),
  );
}

async function checkMysql(): Promise<HealthComponent> {
  const [rows] = await getDatabase().pool.query<
    Array<RowDataPacket & { timezoneOffsetSeconds: number }>
  >(
    "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS timezoneOffsetSeconds",
  );
  return Number(rows[0]?.timezoneOffsetSeconds) === 0
    ? { status: "up" }
    : { status: "down" };
}

async function checkChroma(): Promise<HealthComponent> {
  const baseUrl = loadConfig().CHROMA_URL.replace(/\/$/, "");
  for (const path of ["/api/v2/heartbeat", "/api/v1/heartbeat"]) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return { status: "up" };
    } catch {
      // 兼容不同 Chroma 版本，继续尝试另一个 heartbeat 路径。
    }
  }
  return { status: "down" };
}

async function checkSceneDetect(): Promise<HealthComponent> {
  const config = loadConfig();
  if (!config.SCENE_DETECT_ENABLED) return { status: "disabled" };
  const client = new SceneDetectClient({
    baseUrl: config.SCENE_DETECT_BASE_URL,
    timeoutMs: Math.min(config.SCENE_DETECT_TIMEOUT_MS, 3_000),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await client.health()) return { status: "up" };
    if (attempt === 0) await retryDelay();
  }
  return { status: "down" };
}

async function checkZos(): Promise<HealthComponent> {
  const config = loadConfig();
  if (!config.zosConfigured) return { status: "down" };
  const storage = createZosObjectStorage(config);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await storage.checkHealth(3_000);
      return { status: "up" };
    } catch (error) {
      lastError = error;
      if (attempt === 0) await retryDelay();
    }
  }
  throw lastError;
}

const defaultDependencies: HealthDependencies = {
  now: () => new Date(),
  worker: checkWorker,
  mysql: checkMysql,
  chroma: checkChroma,
  sceneDetect: checkSceneDetect,
  zos: checkZos,
};

async function safeCheck(check: () => Promise<HealthComponent>) {
  try {
    return await check();
  } catch {
    // 健康接口只暴露组件状态，不返回连接地址、凭据或底层异常文本。
    return { status: "down" as const };
  }
}

export async function collectHealth(
  overrides: Partial<HealthDependencies> = {},
): Promise<HealthReport> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const now = dependencies.now();
  const [worker, mysql, chroma, sceneDetect, zos] = await Promise.all([
    safeCheck(() => dependencies.worker(now)),
    safeCheck(dependencies.mysql),
    safeCheck(dependencies.chroma),
    safeCheck(dependencies.sceneDetect),
    safeCheck(dependencies.zos),
  ]);
  const services = {
    web: { status: "up" as const },
    worker,
    mysql,
    chroma,
    scene_detect: sceneDetect,
    zos,
  };
  const available = Object.values(services).every(
    (service) => service.status === "up" || service.status === "disabled",
  );
  return {
    status: available ? "ok" : "unavailable",
    checked_at: shanghaiIso(now),
    services,
  };
}
