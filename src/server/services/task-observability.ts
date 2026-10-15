import { insertTaskLog } from "@/server/observability/store";

import { redact } from "@/server/observability/payload";
import { logCall } from "@/server/observability/trace";
import { callContext } from "@/server/observability/context";
export { redact } from "@/server/observability/payload";

export function taskLogValues(
  taskId: string,
  phase: string,
  message: string,
  data: Record<string, unknown> | null = null,
  level: "info" | "warn" | "error" = "info",
) {
  return {
    taskId, phase, level,
    message: String(redact(message)).slice(0, 8_192),
    data: redact(data) as Record<string, unknown> | null,
    createdAt: new Date(),
  };
}

/** 附加日志失败不能让已经完成的媒体操作变成失败。创建/终态关键日志使用同一事务。 */
export async function appendTaskLog(
  taskId: string | null,
  phase: string,
  message: string,
  data: Record<string, unknown> | null = null,
  level: "info" | "warn" | "error" = "info",
) {
  await logCall(message, data, level);
  if (!taskId) return;
  try {
    await insertTaskLog(taskLogValues(taskId, phase, message, data, level));
  } catch {
    console.error(`Task log persistence failed for ${taskId}.`);
  }
}

/** 业务步骤同时进入当前调用与关联任务；独立函数只记录调用，不伪造任务。 */
export async function logTaskStep(phase: string, message: string, data: Record<string, unknown> | null = null, level: "info" | "warn" | "error" = "info") {
  const context = callContext.getStore();
  if (!context) return;
  await appendTaskLog(context.task.id, phase, message, data, level);
}

export function shanghaiIso(value: Date): string;
export function shanghaiIso(value: Date | null): string | null;
export function shanghaiIso(value: Date | null) {
  return value ? new Date(value.getTime() + 8 * 60 * 60 * 1_000).toISOString().replace("Z", "+08:00") : null;
}
