import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/server/db";
import { callLogs, callSpans, jobs, tasks, taskLogs } from "@/server/db/schema";
import { errorSummary } from "@/shared/log-message";

export async function startCall(row: typeof callSpans.$inferInsert) {
  await db.transaction(async (tx) => {
    await tx.insert(callSpans).values(row);
    await tx.insert(callLogs).values({ spanId: row.id, level: "info", message: "调用开始。", createdAt: row.startedAt });
  });
}

export async function finishCall(id: string, row: Partial<typeof callSpans.$inferInsert>) {
  await db.transaction(async (tx) => {
    await tx.update(callSpans).set(row).where(eq(callSpans.id, id));
    if (row.taskId && row.traceId) {
      await tx.update(callSpans).set({ taskId: row.taskId })
        .where(and(eq(callSpans.traceId, row.traceId), isNull(callSpans.taskId)));
    }
    await tx.insert(callLogs).values({
      spanId: id, level: row.status === "failed" ? "error" : "info",
      message: row.status === "failed" ? `调用失败：${errorSummary(row.error) || "请查看关联任务和错误详情。"}`.slice(0, 8192) : "调用完成。",
      data: row.error ?? { duration_ms: row.durationMs }, createdAt: row.finishedAt ?? new Date(),
    });
  });
}

export async function insertCallLog(row: typeof callLogs.$inferInsert) {
  await db.insert(callLogs).values(row);
}

export async function taskCallContext(taskId: string) {
  const [task] = await db.select({ traceId: tasks.traceId, parentSpanId: tasks.originSpanId })
    .from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return task;
}

export async function jobCallOutcome(id: string, attempt: number) {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.attempt, attempt))).limit(1);
  if (!job) return undefined;
  return {
    failed: job.status === "failed" || job.status === "queued",
    output: { job_id: job.id, status: job.status, attempt: job.attempt, phase: job.phase },
    error: job.errorCode || job.errorMessage ? { code: job.errorCode, message: job.errorMessage } : null,
  };
}

export async function deleteExpiredCalls(now = new Date()) {
  await db.delete(callSpans).where(lt(callSpans.expiresAt, now));
}

export async function insertTaskLog(row: typeof taskLogs.$inferInsert) {
  await db.insert(taskLogs).values(row);
}
