import crypto from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { assets, jobs, taskItems, tasks } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { ScenePipelineError } from "@/server/scene/types";

export interface PersistedTaskError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** 任务状态机自身产生的公开错误，不复用媒体或分镜错误码。 */
export class TaskLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskLifecycleError";
  }
}

export function persistedTaskError(error: unknown): PersistedTaskError {
  if (error instanceof TaskLifecycleError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof ScenePipelineError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "任务处理失败。",
  };
}

export async function markTaskItemRunning(
  taskId: string,
  itemId: string,
  phase: "validating" | "splitting" | "persisting" | "analyzing",
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(taskItems)
      .set({
        status: "running",
        phase,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        updatedAt: now,
      })
      .where(and(eq(taskItems.id, itemId), eq(taskItems.taskId, taskId)));
    await tx
      .update(tasks)
      .set({
        status: "running",
        phase,
        startedAt: sql`coalesce(${tasks.startedAt}, ${now})`,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
  });
}

async function enqueueTerminalCallback(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
  now: Date,
) {
  const [task] = await tx
    .select({ callbackUrl: tasks.callbackUrl })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task?.callbackUrl) return;
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.taskId, taskId), eq(jobs.type, "callback")))
    .limit(1);
  if (existing) return;
  await tx.insert(jobs).values({
    id: crypto.randomUUID(),
    taskId,
    type: "callback",
    phase: "notifying",
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** 聚合逐文件终态；只有所有 item 都进入 finished 后，上传任务才进入终态。 */
export async function refreshUploadTask(taskId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: taskItems.status, phase: taskItems.phase })
      .from(taskItems)
      .where(eq(taskItems.taskId, taskId));
    if (!rows.length) return;
    const finished = rows.filter((item) => item.phase === "finished");
    const doneItems = finished.filter((item) => item.status === "done").length;
    const failedItems = finished.filter((item) => item.status === "failed").length;
    const terminal = finished.length === rows.length;
    const activePhase = rows.find((item) => item.status === "running")?.phase;
    const progressPercent = terminal
      ? 100
      : Math.min(99, (finished.length / rows.length) * 100);
    await tx
      .update(tasks)
      .set({
        status: terminal ? (failedItems > 0 ? "failed" : "done") : "running",
        phase: terminal ? "finished" : (activePhase ?? "validating"),
        doneItems,
        failedItems,
        progressPercent,
        finishedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    if (terminal) await enqueueTerminalCallback(tx, taskId, now);
  });
}

export async function failTaskItem(
  taskId: string,
  itemId: string,
  error: unknown,
) {
  const failure = persistedTaskError(error);
  const now = new Date();
  await db
    .update(taskItems)
    .set({
      status: "failed",
      phase: "finished",
      errorCode: failure.code,
      errorMessage: failure.message,
      errorDetails: failure.details ?? null,
      updatedAt: now,
    })
    .where(and(eq(taskItems.id, itemId), eq(taskItems.taskId, taskId)));
  await refreshUploadTask(taskId);
}

export async function markTaskItemPersisted(taskId: string, itemId: string) {
  await markTaskItemRunning(taskId, itemId, "analyzing");
}

/** 在一个 item 的全部图片/切片分析终止后，向上聚合 item 和 task。 */
export async function refreshTaskForAsset(assetId: string) {
  const [asset] = await db
    .select({ taskId: assets.taskId, taskItemId: assets.taskItemId })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset?.taskId || !asset.taskItemId) return;
  const siblings = await db
    .select({ status: assets.processingStatus })
    .from(assets)
    .where(eq(assets.taskItemId, asset.taskItemId));
  if (!siblings.length) return;
  const terminal = siblings.every(
    ({ status }) => status === "completed" || status === "failed",
  );
  if (!terminal) return;
  const failed = siblings.some(({ status }) => status === "failed");
  await db
    .update(taskItems)
    .set({
      status: failed ? "failed" : "done",
      phase: "finished",
      ...(failed
        ? {
            errorCode: "model_request_failed",
            errorMessage: "一个或多个素材切片分析失败，请查看 asset_ids。",
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(taskItems.id, asset.taskItemId));
  await refreshUploadTask(asset.taskId);
}

export async function finishMutationTask(
  taskId: string,
  result: Record<string, unknown> = {},
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "done",
        phase: "finished",
        progressPercent: 100,
        doneItems: 1,
        failedItems: 0,
        result,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    await enqueueTerminalCallback(tx, taskId, now);
  });
}

export async function failMutationTask(taskId: string, error: unknown) {
  const failure = persistedTaskError(error);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "failed",
        phase: "finished",
        progressPercent: 100,
        doneItems: 0,
        failedItems: 1,
        errorCode: failure.code,
        errorMessage: failure.message,
        errorDetails: failure.details ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    await enqueueTerminalCallback(tx, taskId, now);
  });
}

export async function markAssetsAnalyzing(assetIds: string[]) {
  if (!assetIds.length) return;
  await db
    .update(assets)
    .set({ processingStatus: "analyzing", updatedAt: new Date() })
    .where(inArray(assets.id, assetIds));
}

/**
 * 修复 worker 在“业务事务已提交、任务聚合尚未提交”之间退出留下的状态窗口。
 *
 * 该扫描只处理数据库中已经进入终态的素材/作业，不会抢占仍在运行的工作。所有
 * 操作均幂等，可在 worker 启动及周期清理时重复执行。
 */
export async function reconcileActiveTaskLifecycles() {
  const active = await db
    .select({ id: tasks.id, type: tasks.type })
    .from(tasks)
    .where(eq(tasks.status, "running"));
  let reconciled = 0;

  for (const task of active) {
    if (task.type === "upload") {
      const rows = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.taskId, task.id));
      for (const asset of rows) await refreshTaskForAsset(asset.id);
      // 没有 asset 的失败 item 也可在这里向任务主表重新聚合。
      await refreshUploadTask(task.id);
      reconciled += 1;
      continue;
    }

    if (task.type !== "retry") continue;
    const [analysisJob] = await db
      .select({
        assetId: jobs.assetId,
        status: jobs.status,
        errorCode: jobs.errorCode,
        errorMessage: jobs.errorMessage,
      })
      .from(jobs)
      .where(and(eq(jobs.taskId, task.id), eq(jobs.type, "analyze")))
      .limit(1);
    if (!analysisJob || !["done", "failed"].includes(analysisJob.status)) {
      continue;
    }
    if (analysisJob.status === "failed") {
      await failMutationTask(
        task.id,
        new TaskLifecycleError(
          analysisJob.errorCode ?? "internal_error",
          analysisJob.errorMessage ?? "素材重试失败。",
        ),
      );
    } else if (analysisJob.assetId) {
      await finishMutationTask(task.id, { asset_id: analysisJob.assetId });
    }
    reconciled += 1;
  }
  return reconciled;
}
