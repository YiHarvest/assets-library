import { Injectable } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { DatabaseService } from "../../database/database.service";
import { ZosService } from "../../storage/zos.service";
import { loadConfig } from "../../config";
import { workerHeartbeatPaths } from "../../worker-heartbeat";

@Injectable()
export class HealthService {
  private readonly config = loadConfig();
  constructor(private readonly database: DatabaseService, private readonly zos: ZosService) {}

  async check() {
    const checks = await Promise.allSettled([
      this.database.pool.query("select 1"),
      this.zos.health(),
      fetch(`${this.config.CHROMA_URL.replace(/\/$/, "")}/api/v2/heartbeat`, { signal: AbortSignal.timeout(3000) }).then((response) => { if (!response.ok) throw new Error(); }),
      fetch(`${this.config.SCENE_DETECT_BASE_URL.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(this.config.SCENE_HEALTH_TIMEOUT_MS) }).then((response) => { if (!response.ok) throw new Error(); }),
      Promise.all(workerHeartbeatPaths(this.config.WORKER_INSTANCES).map(async (heartbeatPath) => {
        const raw = await readFile(heartbeatPath, "utf8");
        const heartbeat = JSON.parse(raw) as { updated_at?: string };
        if (!heartbeat.updated_at || Date.now() - new Date(heartbeat.updated_at).getTime() > 10_000) throw new Error();
      })),
    ]);
    const names = ["mysql", "zos", "chroma", "scene", "worker"];
    const dependencies = Object.fromEntries(names.map((name, index) => [name, checks[index].status === "fulfilled" ? "up" : "down"]));
    return { status: checks.every((check) => check.status === "fulfilled") ? "up" : "degraded", dependencies, checked_at: new Date().toISOString() };
  }
}
