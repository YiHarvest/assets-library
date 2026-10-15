import crypto from "node:crypto";
import { callContext, type CallContext } from "./context";
import { auditEventMessage } from "@/shared/log-message";
import { responseSnapshot, snapshot } from "./payload";
import * as store from "./store";

export interface CallOutcome { failed?: boolean; output?: unknown; error?: unknown }
interface ObserveOptions {
  kind?: "api" | "function" | "match";
  taskId?: string | null;
  traceId?: string | null;
  parentSpanId?: string | null;
  outcome?: () => Promise<CallOutcome | undefined>;
}

let lastWarning = 0;
async function safely<T>(action: () => Promise<T>): Promise<T | undefined> {
  try { return await action(); }
  catch {
    if (Date.now() - lastWarning > 30000) {
      console.error("Call observation persistence failed; business execution continues.");
      lastWarning = Date.now();
    }
  }
}

function resultTaskId(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const id = "task_id" in value ? value.task_id : "taskId" in value ? value.taskId : null;
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** 业务入口统一包装；保持返回值/异常不变，观测写入失败不改变业务结果。 */
export async function observe<T>(name: string, input: unknown, run: () => Promise<T>, options: ObserveOptions = {}): Promise<T> {
  const parent = callContext.getStore();
  if (parent === null) return run();
  const id = crypto.randomUUID();
  const traceId = options.traceId ?? parent?.traceId ?? crypto.randomUUID();
  const task = parent?.task ?? { id: options.taskId ?? null };
  if (options.taskId) task.id = options.taskId;
  const context: CallContext = { traceId, spanId: id, task, input: snapshot(input) };
  const startedAt = new Date();
  const start = performance.now();
  const days = Number(process.env.TASK_RETENTION_DAYS || 7);
  const persisted = await safely(async () => {
    await store.startCall({ id, traceId, parentSpanId: options.parentSpanId ?? parent?.spanId ?? null,
      taskId: task.id, kind: options.kind ?? "function", name: name.slice(0, 512), input: context.input,
      startedAt, expiresAt: new Date(startedAt.getTime() + (Number.isFinite(days) && days > 0 ? days : 7) * 86400000) });
    return true;
  });
  context.onAudit = (event, fields, level) => {
    if (!persisted) return;
    const linkedTask = resultTaskId(fields);
    if (linkedTask) task.id = linkedTask;
    const taskId = task.id;
    const createdAt = new Date();
    const data = snapshot(fields) as Record<string, unknown>;
    const message = String(snapshot(auditEventMessage(event, fields)));
    context.pendingLogs = (context.pendingLogs ?? Promise.resolve()).then(async () => {
      await safely(() => store.insertCallLog({ spanId: id, message, level, data, createdAt }));
      if (taskId) await safely(() => store.insertTaskLog({ taskId, phase: event.slice(0, 64), message, level, data, createdAt }));
    });
  };
  return callContext.run(context, async () => {
    let output: unknown = null;
    let error: unknown = null;
    let failed = false;
    let statusCode: number | null = null;
    try {
      const result = await run();
      output = result instanceof Response ? await responseSnapshot(result) : snapshot(result);
      const linkedTask = resultTaskId(output);
      if (linkedTask) task.id = linkedTask;
      if (result instanceof Response) {
        statusCode = result.status;
        failed = result.status >= 400;
        if (failed) error = output;
      }
      const outcome = options.outcome ? await safely(options.outcome) : undefined;
      if (outcome) { failed = Boolean(outcome.failed); output = snapshot(outcome.output); error = snapshot(outcome.error); }
      return result;
    } catch (cause) {
      failed = true; error = snapshot(cause);
      throw cause;
    } finally {
      await context.pendingLogs;
      if (persisted) await safely(() => store.finishCall(id, {
        traceId, taskId: task.id, input: snapshot(context.input), output, error,
        status: failed ? "failed" : "done", statusCode,
        durationMs: Math.max(0, performance.now() - start), finishedAt: new Date(),
      }));
    }
  });
}

export async function logCall(message: string, data: unknown = null, level: "info" | "warn" | "error" = "info") {
  const context = callContext.getStore();
  if (!context) return;
  await context.pendingLogs;
  await safely(() => store.insertCallLog({ spanId: context.spanId, level, message: String(snapshot(message)), data: snapshot(data), createdAt: new Date() }));
}

export async function observeJob<T>(name: string, job: { id: string; taskId: string | null; attempt: number }, input: unknown, run: () => Promise<T>) {
  const parent = job.taskId ? await safely(() => store.taskCallContext(job.taskId!)) : undefined;
  return observe(name, input, run, { taskId: job.taskId, ...parent,
    outcome: () => store.jobCallOutcome(job.id, job.attempt),
  });
}
