import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  traceId: string;
  spanId: string;
  task: { id: string | null };
  input: unknown;
  pendingLogs?: Promise<unknown>;
  onAudit?: (event: string, fields: Record<string, unknown>, level: "info" | "warn" | "error") => void;
}

// null 表示监控查询，整个查询链都不生成观测记录。
export const callContext = new AsyncLocalStorage<CallContext | null>();

export function taskTraceFields(taskId?: string) {
  const context = callContext.getStore();
  if (context && taskId) context.task.id = taskId;
  return { traceId: context?.traceId ?? null, originSpanId: context?.spanId ?? null };
}

export function captureRequestBody(body: unknown) {
  const context = callContext.getStore();
  if (context) context.input = { ...context.input as object, body };
}
