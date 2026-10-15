import { and, asc, desc, eq, gt, like, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { callLogs, callSpans, tasks } from "@/server/db/schema";
import { ApiV1Error } from "@/server/api/errors";
import { snapshot } from "@/server/observability/payload";
import { shanghaiIso } from "./task-observability";
import type { CallDetail, CallList, CallQuery, CallRecord } from "@/shared/call-contracts";

const fields = {
  id: callSpans.id, trace_id: callSpans.traceId, parent_span_id: callSpans.parentSpanId,
  task_id: callSpans.taskId, kind: callSpans.kind, name: callSpans.name, status: callSpans.status,
  status_code: callSpans.statusCode, duration_ms: callSpans.durationMs,
  startedAt: callSpans.startedAt, finishedAt: callSpans.finishedAt,
  task_status: tasks.status, task_phase: tasks.phase, task_progress: tasks.progressPercent,
};
function toRecord(row: Omit<CallRecord, "started_at" | "finished_at"> & { startedAt: Date; finishedAt: Date | null }): CallRecord {
  const { startedAt, finishedAt, ...rest } = row;
  return { ...rest, started_at: shanghaiIso(startedAt), finished_at: shanghaiIso(finishedAt) };
}

export async function listCalls(query: CallQuery): Promise<CallList> {
  const where = and(
    query.kind ? eq(callSpans.kind, query.kind) : undefined,
    query.status ? eq(callSpans.status, query.status) : undefined,
    query.task_id ? eq(callSpans.taskId, query.task_id) : undefined,
    query.trace_id ? eq(callSpans.traceId, query.trace_id) : undefined,
    query.q ? like(callSpans.name, `%${query.q}%`) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db.select(fields).from(callSpans).leftJoin(tasks, eq(tasks.id, callSpans.taskId)).where(where)
      .orderBy(desc(callSpans.startedAt), desc(callSpans.id)).limit(query.limit).offset((query.page - 1) * query.limit),
    db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(callSpans).where(where),
  ]);
  return { items: rows.map(toRecord), total: total.count, page: query.page, has_more: query.page * query.limit < total.count };
}

export async function callDetail(id: string, after: number, limit: number): Promise<CallDetail> {
  const [row] = await db.select({ ...fields, input: callSpans.input, output: callSpans.output, error: callSpans.error })
    .from(callSpans).leftJoin(tasks, eq(tasks.id, callSpans.taskId)).where(eq(callSpans.id, id)).limit(1);
  if (!row) throw new ApiV1Error("not_found", "调用不存在或已过保留期限。", 404);
  const logs = await db.select().from(callLogs).where(and(eq(callLogs.spanId, id), gt(callLogs.id, after)))
    .orderBy(asc(callLogs.id)).limit(limit + 1);
  const page = logs.slice(0, limit);
  return {
    call: { ...toRecord(row), input: snapshot(row.input), output: snapshot(row.output), error: snapshot(row.error) },
    logs: page.map((log) => ({ id: log.id, level: log.level, message: log.message, data: log.data, created_at: shanghaiIso(log.createdAt) })),
    next_after: page.at(-1)?.id ?? after, has_more: logs.length > limit,
  };
}
