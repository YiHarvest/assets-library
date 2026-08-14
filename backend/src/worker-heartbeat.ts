import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workerLog } from "./worker/logger";

export function workerHeartbeatPath() {
  const workerIndex = process.env.WORKER_INDEX ?? "1";
  return path.resolve(process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".run"), `worker-${workerIndex}.heartbeat.json`);
}

export function workerHeartbeatPaths(instances: number) {
  const runtimeDir = process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".run");
  return Array.from({ length: instances }, (_, index) =>
    path.resolve(runtimeDir, `worker-${index + 1}.heartbeat.json`));
}

async function writeHeartbeat(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: process.pid, updated_at: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, filePath);
}

export async function startWorkerHeartbeat() {
  const filePath = workerHeartbeatPath();
  await writeHeartbeat(filePath);
  // 文件系统或磁盘繁忙时一次 rename 可能超过2秒。串行化写入，避免两个
  // tick 同时复用 `${pid}.tmp`，其中一个先 rename 后另一个触发 ENOENT。
  let pendingWrite = Promise.resolve();
  const pulse = () => {
    pendingWrite = pendingWrite
      .then(() => writeHeartbeat(filePath))
      .catch((error) => {
        workerLog({ operationId: randomUUID(), stage: "process_heartbeat", status: "failed", error });
      });
  };
  const timer = setInterval(pulse, 2_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pendingWrite;
    try {
      const value = JSON.parse(await readFile(filePath, "utf8")) as { pid?: number };
      if (value.pid === process.pid) await rm(filePath, { force: true });
    } catch { /* heartbeat already absent */ }
  };
}
