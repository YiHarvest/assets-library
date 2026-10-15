import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { callbackDeliveries, jobs, taskLogs, tasks } from "@/server/db/schema";
import { ApiV1Error } from "@/server/api/errors";
import { getApiV1Service } from "@/server/api/v1/service";
import { redact, shanghaiIso } from "./task-observability";
import type { MonitorDetail, MonitorQuery, MonitorTaskList, TaskLogPage, TaskLogQuery } from "@/shared/monitor-contracts";

export async function listMonitorTasks(query: MonitorQuery): Promise<MonitorTaskList> {
  const scope = and(
    query.type ? eq(tasks.type, query.type) : undefined,
    query.task_id ? eq(tasks.id, query.task_id) : undefined,
    query.user_id ? eq(tasks.userId, query.user_id) : undefined,
  );
  const where = and(scope, query.status ? eq(tasks.status, query.status) : undefined);
  const [rows, totals] = await Promise.all([
    db.select({
      task_id: tasks.id, task_type: tasks.type, status: tasks.status, phase: tasks.phase,
      user_id: tasks.userId, progress_percent: tasks.progressPercent,
      total_items: tasks.totalItems, done_items: tasks.doneItems, failed_items: tasks.failedItems,
      createdAt: tasks.createdAt, startedAt: tasks.startedAt, finishedAt: tasks.finishedAt,
      updatedAt: tasks.updatedAt, error_message: tasks.errorMessage,
    }).from(tasks).where(where).orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(query.limit).offset((query.page - 1) * query.limit),
    db.select({ status: tasks.status, count: sql<number>`count(*)`.mapWith(Number) })
      .from(tasks).where(scope).groupBy(tasks.status),
  ]);
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const row of totals) counts[row.status] = row.count;
  const total = query.status ? counts[query.status] : Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    items: rows.map(({ createdAt, startedAt, finishedAt, updatedAt, ...row }) => ({
      ...row, error_message: redact(row.error_message) as string | null,
      created_at: shanghaiIso(createdAt), started_at: shanghaiIso(startedAt),
      finished_at: shanghaiIso(finishedAt), updated_at: shanghaiIso(updatedAt),
    })),
    total, counts, page: query.page, limit: query.limit, has_more: query.page * query.limit < total,
  };
}

async function requireTask(taskId: string) {
  const [task] = await db.select({ input: tasks.input }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new ApiV1Error("not_found", "任务不存在或已过保留期限。", 404);
  return task;
}

export async function getMonitorDetail(taskId: string): Promise<MonitorDetail> {
  const record = await requireTask(taskId);
  const [task, jobRows, deliveries] = await Promise.all([
    getApiV1Service().getTask(taskId),
    db.select().from(jobs).where(eq(jobs.taskId, taskId)).orderBy(asc(jobs.createdAt), asc(jobs.id)),
    db.select().from(callbackDeliveries).where(eq(callbackDeliveries.taskId, taskId)).orderBy(asc(callbackDeliveries.startedAt)),
  ]);
  return redact({
    task, input: record.input, output: task,
    jobs: jobRows.map((row) => ({
      job_id: row.id, type: row.type, status: row.status, phase: row.phase,
      attempt: row.attempt, input: row.payload, error_code: row.errorCode,
      error_message: row.errorMessage, updated_at: shanghaiIso(row.updatedAt),
    })),
    callbacks: deliveries.map((row) => ({
      attempt: row.attempt, input: row.requestBody, status_code: row.responseStatus,
      output: row.responseBody, error_message: row.errorMessage,
      started_at: shanghaiIso(row.startedAt), completed_at: shanghaiIso(row.completedAt),
    })),
  }) as MonitorDetail;
}

export async function getTaskLogs(taskId: string, query: TaskLogQuery): Promise<TaskLogPage> {
  await requireTask(taskId);
  const rows = await db.select().from(taskLogs)
    .where(and(eq(taskLogs.taskId, taskId), gt(taskLogs.id, query.after)))
    .orderBy(asc(taskLogs.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => ({
      id: row.id, level: row.level, phase: row.phase,
      message: redact(row.message) as string,
      data: redact(row.data) as Record<string, unknown> | null,
      created_at: shanghaiIso(row.createdAt),
    })),
    next_after: page.at(-1)?.id ?? query.after,
    has_more: rows.length > query.limit,
  };
}
