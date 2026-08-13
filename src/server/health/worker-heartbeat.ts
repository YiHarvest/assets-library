import fs from "node:fs/promises";
import path from "node:path";

export const WORKER_HEARTBEAT_INTERVAL_MS = 2_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 10_000;

export interface WorkerHeartbeat {
  pid: number;
  updatedAt: Date;
}

export function workerHeartbeatPath() {
  return path.resolve(process.cwd(), ".run/worker.heartbeat.json");
}

function parseHeartbeat(value: unknown): WorkerHeartbeat | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { pid?: unknown; updated_at?: unknown };
  if (
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 1 ||
    typeof candidate.updated_at !== "string"
  ) {
    return null;
  }
  const updatedAt = new Date(candidate.updated_at);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { pid: Number(candidate.pid), updatedAt };
}

/** 原子更新 worker 心跳，避免 Web 在写入中途读到半段 JSON。 */
export async function writeWorkerHeartbeat(
  filePath = workerHeartbeatPath(),
  now = new Date(),
  pid = process.pid,
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    JSON.stringify({ pid, updated_at: now.toISOString() }),
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, filePath);
}

export async function readWorkerHeartbeat(
  filePath = workerHeartbeatPath(),
): Promise<WorkerHeartbeat | null> {
  try {
    return parseHeartbeat(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

/** 只删除当前 worker 自己的心跳，避免旧进程退出时清掉新进程记录。 */
export async function removeWorkerHeartbeat(
  filePath = workerHeartbeatPath(),
  pid = process.pid,
) {
  const heartbeat = await readWorkerHeartbeat(filePath);
  if (heartbeat?.pid !== pid) return;
  await fs.rm(filePath, { force: true });
}

/**
 * 启动进程级心跳；初次写入失败会阻止 worker 伪装成已就绪。
 */
export async function startWorkerHeartbeat(
  filePath = workerHeartbeatPath(),
) {
  await writeWorkerHeartbeat(filePath);
  const timer = setInterval(() => {
    void writeWorkerHeartbeat(filePath).catch((error) => {
      console.error("Worker heartbeat update failed.", error);
    });
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await removeWorkerHeartbeat(filePath);
  };
}
