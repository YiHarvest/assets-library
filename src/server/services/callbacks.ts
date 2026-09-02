import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { apiTaskErrorPayload } from "@/server/modules/tasks/task-service";
import { assets, callbackDeliveries, taskItems, tasks } from "@/server/db/schema";
import {
  completeJob,
  failJob,
  requeueJob,
  type ClaimedJob,
} from "@/server/repositories/assets";
import { compatibilityCallbackFromJob } from "@/server/services/compatibility-match";

const maximumAttempts = 5;
const maximumResponseCharacters = 4_096;

function shanghaiIso(value: Date | null) {
  if (!value) return null;
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

function callbackBody(
  task: typeof tasks.$inferSelect,
  items: Array<typeof taskItems.$inferSelect>,
  assetIdsByItem: Map<string, string[]>,
) {
  return {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    phase: task.phase,
    progress_percent: task.progressPercent,
    done_items: task.doneItems,
    failed_items: task.failedItems,
    received_bytes: task.receivedBytes,
    total_bytes: task.totalBytes,
    total_items: task.totalItems,
    result: task.result,
    error: apiTaskErrorPayload(task),
    items: items.map((item) => ({
      item_id: item.id,
      filename: item.filename,
      media_type: item.mediaType,
      status: item.status,
      phase: item.phase,
      received_bytes: item.receivedBytes,
      total_bytes: item.totalBytes,
      progress_percent:
        item.totalBytes > 0
          ? Math.min(100, (item.receivedBytes / item.totalBytes) * 100)
          : 0,
      asset_ids: assetIdsByItem.get(item.id) ?? [],
      error: apiTaskErrorPayload(item),
    })),
    created_at: shanghaiIso(task.createdAt),
    started_at: shanghaiIso(task.startedAt),
    finished_at: shanghaiIso(task.finishedAt),
    expires_at: shanghaiIso(task.expiresAt),
  };
}

/** 发送终态回调并记录每次投递；业务任务终态不因回调失败而回滚。 */
export async function processCallbackJob(job: ClaimedJob) {
  if (!job.taskId) {
    await failJob(job);
    return;
  }
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, job.taskId))
    .limit(1);
  if (!task?.callbackUrl) {
    await completeJob(job);
    return;
  }
  const items = await db
    .select()
    .from(taskItems)
    .where(eq(taskItems.taskId, task.id));
  const assetRows = await db
    .select({ id: assets.id, taskItemId: assets.taskItemId })
    .from(assets)
    .where(eq(assets.taskId, task.id));
  const assetIdsByItem = new Map<string, string[]>();
  for (const asset of assetRows) {
    if (!asset.taskItemId) continue;
    const ids = assetIdsByItem.get(asset.taskItemId) ?? [];
    ids.push(asset.id);
    assetIdsByItem.set(asset.taskItemId, ids);
  }
  const body =
    compatibilityCallbackFromJob(job) ??
    callbackBody(task, items, assetIdsByItem);
  const deliveryId = crypto.randomUUID();
  const startedAt = new Date();
  await db.insert(callbackDeliveries).values({
    id: deliveryId,
    taskId: task.id,
    attempt: job.attempt,
    requestBody: body,
    startedAt,
  });
  try {
    const response = await fetch(task.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-assets-task-id": task.id,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      // 不跟随第三方重定向，避免回调目标借 30x 把 worker 引向其他地址。
      redirect: "manual",
    });
    const responseBody = (await response.text()).slice(
      0,
      maximumResponseCharacters,
    );
    if (!response.ok) throw new Error(`回调返回 HTTP ${response.status}。`);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(callbackDeliveries)
        .set({
          responseStatus: response.status,
          responseBody,
          completedAt: now,
        })
        .where(eq(callbackDeliveries.id, deliveryId));
      await tx
        .update(tasks)
        .set({
          callbackAttempts: job.attempt,
          callbackCompletedAt: now,
          nextCallbackAt: null,
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
    });
    await completeJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "回调投递失败。";
    const now = new Date();
    await db
      .update(callbackDeliveries)
      .set({ errorMessage: message, completedAt: now })
      .where(eq(callbackDeliveries.id, deliveryId));
    if (job.attempt < maximumAttempts) {
      const delayMs = Math.min(60_000 * 2 ** (job.attempt - 1), 15 * 60_000);
      await db
        .update(tasks)
        .set({
          callbackAttempts: job.attempt,
          nextCallbackAt: new Date(now.getTime() + delayMs),
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      await requeueJob(job, delayMs);
    } else {
      await db
        .update(tasks)
        .set({ callbackAttempts: job.attempt, nextCallbackAt: null, updatedAt: now })
        .where(eq(tasks.id, task.id));
      await failJob(job);
    }
  }
}
