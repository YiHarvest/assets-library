import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, lt, ne } from "drizzle-orm";
import { loadConfig } from "@/server/config";
import { db } from "@/server/db";
import { taskItems, tasks } from "@/server/db/schema";
import {
  failTaskItem,
  TaskLifecycleError,
} from "@/server/services/task-lifecycle";

export const stagingRetentionMs = 24 * 60 * 60 * 1_000;

async function cleanupExpiredDirectories(
  now: number,
  root: string,
  retentionMs: number,
) {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    const target = path.join(root, entry);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || now - stat.mtimeMs < retentionMs) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** 每小时扫描一次；仅删除超过配置保留期的 staging 文件。 */
export function cleanupExpiredStaging(
  now = Date.now(),
  root = path.join(loadConfig().mediaRoot, ".staging"),
  retentionMs = loadConfig().STAGING_RETENTION_HOURS * 60 * 60 * 1_000,
) {
  return cleanupExpiredDirectories(now, root, retentionMs);
}

/**
 * 清理未被正常消费的分析关键帧工作区。正常作业会在完成或失败后立即删除；
 * 这里兜底处理进程崩溃、作业被取消等情况留下的目录。
 */
export function cleanupExpiredAnalysisWorkspaces(
  now = Date.now(),
  root = path.join(loadConfig().mediaRoot, ".analysis"),
  retentionMs = loadConfig().STAGING_RETENTION_HOURS * 60 * 60 * 1_000,
) {
  return cleanupExpiredDirectories(now, root, retentionMs);
}

/**
 * 把超过 staging 保留期但尚未封存的上传任务置为 failed。
 * 任务记录继续保留到 TASK_RETENTION_DAYS 到期，因此调用方仍能查询明确原因。
 */
export async function expireAbandonedUploadTasks(
  now = new Date(),
  retentionMs = loadConfig().STAGING_RETENTION_HOURS * 60 * 60 * 1_000,
) {
  const staleTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.type, "upload"),
        eq(tasks.status, "queued"),
        lt(tasks.createdAt, new Date(now.getTime() - retentionMs)),
      ),
    );
  const error = new TaskLifecycleError(
    "task_expired",
    "上传任务在暂存保留期内没有完成封存，已自动终止。",
  );
  for (const task of staleTasks) {
    const items = await db
      .select({ id: taskItems.id })
      .from(taskItems)
      .where(
        and(
          eq(taskItems.taskId, task.id),
          ne(taskItems.phase, "finished"),
        ),
      );
    for (const item of items) {
      await failTaskItem(task.id, item.id, error);
    }
  }
  return staleTasks.length;
}
