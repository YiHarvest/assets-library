import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { jobs, taskLogs, tasks } from "@/server/db/schema";
import { loadConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import { getApiV1Service } from "@/server/api/v1/service";
import type { ClaimedJob } from "@/server/repositories/assets";
import { enqueueTerminalCallback, persistedTaskError } from "./task-lifecycle";
import { redact, taskLogValues, logTaskStep } from "./task-observability";
import { matchRequestSchema, type MatchRequest, type MatchResult } from "@/shared/monitor-contracts";
import { observe } from "@/server/observability/trace";
import { taskTraceFields } from "@/server/observability/context";

/** 可在服务端直接复用的素材匹配函数，统一复用现有 SQL 作用域过滤与 Elasticsearch 检索与排序。 */
export async function match(input: MatchRequest): Promise<MatchResult> {
  return observe("match", input, () => runMatch(input), { kind: "match" });
}

async function runMatch(input: MatchRequest): Promise<MatchResult> {
  await logTaskStep("matching", "开始校验匹配参数与 embedding 配置。");
  const request = matchRequestSchema.parse(input);
  if (!loadConfig().embeddingConfigured) {
    await logTaskStep("matching", "素材匹配中止：未配置 embedding 服务，尚未执行检索。", { code: "model_not_configured" }, "error");
    throw new ApiV1Error("model_not_configured", "请先配置 embedding 服务后再进行素材匹配。", 503);
  }
  await logTaskStep("matching", "开始按用户范围、媒体类型和标签筛选，并执行语义检索。", { filter: request.filter, limit: request.limit });
  const result = await getApiV1Service().queryAssets({
    query: request.query,
    keywords: request.keywords,
    filter: { ...request.filter, statuses: request.filter.statuses ?? ["done"] },
    cursor: null,
    limit: request.limit,
    include_tag_statistics: false,
  });
  const items = result.items
    .filter((item) => typeof item.semantic_score === "number" && item.semantic_score >= request.min_score)
    .sort((a, b) => b.semantic_score! - a.semantic_score!)
    .slice(0, request.limit);
  await logTaskStep("matching", `检索与相似度筛选完成，匹配到 ${items.length} 个素材。`, { returned_candidates: result.items.length, matched_count: items.length, min_score: request.min_score });
  return { query: request.query, items, matched_count: items.length, min_score: request.min_score };
}

export async function createMatchTask(input: MatchRequest) {
  return observe("createMatchTask", input, () => enqueueMatch(input));
}

async function enqueueMatch(input: MatchRequest) {
  const request = matchRequestSchema.parse(input);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      ...taskTraceFields(id),
      id, type: "match", phase: "matching", totalItems: 1,
      userId: request.filter.user_scope.mode === "user" ? request.filter.user_scope.user_id : null,
      callbackUrl: request.callback_url,
      input: redact(request) as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + loadConfig().TASK_RETENTION_DAYS * 86_400_000),
      createdAt: now, updatedAt: now,
    });
    await tx.insert(jobs).values({
      id: crypto.randomUUID(), taskId: id, type: "match", phase: "matching",
      payload: { ...request, callback_url: null },
      availableAt: now, createdAt: now, updatedAt: now,
    });
    await tx.insert(taskLogs).values(taskLogValues(id, "matching", "匹配请求已接收，等待 worker。"));
  });
  return getApiV1Service().getTask(id);
}

/** 状态与输出在同一事务提交；attempt fencing 防止失去租约的旧 worker 覆盖新结果。 */
export async function processMatchJob(job: ClaimedJob) {
  if (!job.taskId) throw new Error("匹配作业缺少 task_id。");
  const taskId = job.taskId;
  const ownsJob = and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.attempt, job.attempt),
    job.leaseOwner ? eq(jobs.leaseOwner, job.leaseOwner) : undefined);
  const active = await db.transaction(async (tx) => {
    const [lease] = await tx.select({ id: jobs.id }).from(jobs).where(ownsJob).for("update");
    if (!lease) return false;
    const now = new Date();
    await tx.update(tasks).set({
      status: "running", phase: "matching", progressPercent: 10,
      startedAt: sql`coalesce(${tasks.startedAt}, ${now})`, updatedAt: now,
    }).where(eq(tasks.id, taskId));
    await tx.insert(taskLogs).values(taskLogValues(taskId, "matching", "开始过滤候选素材并执行语义检索。", { job_id: job.id, attempt: job.attempt }));
    return true;
  });
  if (!active) return;
  let result: MatchResult | undefined;
  let failure: ReturnType<typeof persistedTaskError> | undefined;
  try {
    result = await match(matchRequestSchema.parse(job.payload));
  } catch (error) {
    failure = error instanceof ApiV1Error
      ? { code: error.code, message: error.message }
      : persistedTaskError(error);
  }
  await db.transaction(async (tx) => {
    const [lease] = await tx.select({ id: jobs.id }).from(jobs).where(ownsJob).for("update");
    if (!lease) return;
    const now = new Date();
    await tx.update(tasks).set({
      status: failure ? "failed" : "done", phase: "finished", progressPercent: 100,
      doneItems: failure ? 0 : 1, failedItems: failure ? 1 : 0,
      result: result ? { ...result } : null,
      errorCode: failure?.code ?? null, errorMessage: failure?.message ?? null,
      errorDetails: failure?.details ?? null, finishedAt: now, updatedAt: now,
    }).where(eq(tasks.id, taskId));
    await tx.update(jobs).set({
      status: failure ? "failed" : "done", phase: "finished",
      errorCode: failure?.code ?? null, errorMessage: failure?.message ?? null, updatedAt: now,
    }).where(ownsJob);
    await tx.insert(taskLogs).values(taskLogValues(taskId, "finished",
      failure ? `素材匹配失败：${failure.message}` : `匹配完成，找到 ${result!.matched_count} 个素材。`,
      failure ? { error: failure } : { matched_count: result!.matched_count },
      failure ? "error" : "info",
    ));
    await enqueueTerminalCallback(tx, taskId, now);
  });
}
