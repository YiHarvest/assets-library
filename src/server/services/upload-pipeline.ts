import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import {
  assets,
  jobs,
  mediaObjects,
  taskItemSegments,
  taskItems,
  tasks,
  videoSources,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import {
  removeAnalysisWorkspace,
  resolveMediaPath,
  seedAnalysisVideoFrames,
} from "@/server/media/storage";
import { validateMediaFile } from "@/server/media/validate";
import { prepareSceneBatch, cleanupPreparedSceneBatch } from "@/server/scene/batch";
import { SceneDetectClient } from "@/server/scene/client";
import { ScenePipelineError } from "@/server/scene/types";
import {
  completeJob,
  failJob,
  type ClaimedJob,
} from "@/server/repositories/assets";
import { persistSceneBatch } from "@/server/services/scene-persistence";
import {
  failTaskItem,
  markTaskItemPersisted,
  markTaskItemRunning,
} from "@/server/services/task-lifecycle";
import type { ObjectStorage, StoredObject } from "@/server/storage/object-storage";
import { createZosObjectStorage } from "@/server/storage/zos";
import { loadConfig, type AppConfig } from "@/server/config";

interface UploadContext {
  task: typeof tasks.$inferSelect;
  item: typeof taskItems.$inferSelect;
  autoPublish: boolean;
}

export interface UploadPipelineDependencies {
  config: AppConfig;
  storage: ObjectStorage;
  sceneClient: SceneDetectClient;
  now: () => Date;
}

function defaultDependencies(): UploadPipelineDependencies {
  const config = loadConfig();
  return {
    config,
    storage: createZosObjectStorage(config),
    sceneClient: new SceneDetectClient({
      baseUrl: config.SCENE_DETECT_BASE_URL,
      timeoutMs: config.SCENE_DETECT_TIMEOUT_MS,
      pollIntervalMs: config.SCENE_DETECT_POLL_INTERVAL_MS,
    }),
    now: () => new Date(),
  };
}

function taskItemId(job: ClaimedJob) {
  const value = job.payload?.taskItemId;
  if (typeof value !== "string") {
    throw new AppError("invalid_request", "校验作业缺少 taskItemId。", 500);
  }
  return value;
}

async function uploadContext(job: ClaimedJob): Promise<UploadContext> {
  if (!job.taskId) {
    throw new AppError("invalid_request", "上传作业缺少 taskId。", 500);
  }
  const itemId = taskItemId(job);
  const [row] = await db
    .select({ task: tasks, item: taskItems })
    .from(taskItems)
    .innerJoin(tasks, eq(tasks.id, taskItems.taskId))
    .where(and(eq(tasks.id, job.taskId), eq(taskItems.id, itemId)))
    .limit(1);
  if (!row || row.task.type !== "upload") {
    throw new AppError("invalid_request", "上传任务或文件不存在。", 404);
  }
  const result = row.task.result as { auto_publish?: unknown } | null;
  return {
    ...row,
    autoPublish: result?.auto_publish === true,
  };
}

function datePrefix(now: Date) {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

function baseName(filename: string) {
  return path.basename(filename, path.extname(filename)).slice(0, 255) || "未命名素材";
}

function stagingPath(
  context: UploadContext,
  dependencies: UploadPipelineDependencies,
) {
  return resolveMediaPath(context.item.stagingPath, dependencies.config.mediaRoot);
}

async function removeStagingFile(filePath: string) {
  await fs.rm(filePath, { force: true });
  await fs.rmdir(path.dirname(filePath)).catch(() => undefined);
}

function mediaObjectValues(
  id: string,
  object: StoredObject,
  mimeType: string,
  bucket: string | undefined,
  now: Date,
) {
  return {
    id,
    provider: "zos" as const,
    bucket: bucket?.trim() || null,
    objectKey: object.key,
    publicUrl: object.url ?? null,
    localPath: null,
    sha256: null,
    mimeType,
    sizeBytes: object.sizeBytes,
    status: "persisted" as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function alreadyPersisted(itemId: string) {
  const [row] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.taskItemId, itemId))
    .limit(1);
  return Boolean(row);
}

async function processImage(
  job: ClaimedJob,
  context: UploadContext,
  validated: Awaited<ReturnType<typeof validateMediaFile>>,
  dependencies: UploadPipelineDependencies,
) {
  const now = dependencies.now();
  const assetId = crypto.randomUUID();
  const mediaObjectId = crypto.randomUUID();
  const key = `assets/images/${datePrefix(now)}/${context.task.id}/${context.item.id}${validated.extension}`;
  const stored = await dependencies.storage.storeFile({
    key,
    filePath: stagingPath(context, dependencies),
    contentType: validated.mimeType,
  });
  try {
    // ZOS 与 MySQL 无法共享事务：对象先写入，建档失败时立即补偿删除。
    await db.transaction(async (tx) => {
      await tx.insert(mediaObjects).values(
        mediaObjectValues(
          mediaObjectId,
          stored,
          validated.mimeType,
          dependencies.config.ZOS_BUCKET,
          now,
        ),
      );
      await tx.insert(assets).values({
        id: assetId,
        userId: context.task.userId,
        taskId: context.task.id,
        taskItemId: context.item.id,
        mediaObjectId,
        name: baseName(context.item.filename),
        description: "",
        mediaType: "image",
        originalFilename: context.item.filename,
        originalPath: stored.key,
        mimeType: validated.mimeType,
        sizeBytes: stored.sizeBytes,
        directPublish: context.autoPublish,
        processingStatus: "analyzing",
        reviewStatus: "pending_review",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(jobs).values({
        id: crypto.randomUUID(),
        taskId: context.task.id,
        assetId,
        type: "analyze",
        phase: "analyzing",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(jobs)
        .set({ status: "done", updatedAt: now })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, "running"),
            eq(jobs.attempt, job.attempt),
          ),
        );
      await tx
        .update(taskItems)
        .set({
          mediaType: "image",
          status: "running",
          phase: "analyzing",
          updatedAt: now,
        })
        .where(eq(taskItems.id, context.item.id));
    });
  } catch (error) {
    await dependencies.storage.deleteObject(stored.key).catch(() => undefined);
    throw error;
  }
}

async function processVideo(
  job: ClaimedJob,
  context: UploadContext,
  dependencies: UploadPipelineDependencies,
) {
  if (!dependencies.config.SCENE_DETECT_ENABLED) {
    throw new ScenePipelineError(
      "scene_service_unavailable",
      "视频分镜服务未启用。",
    );
  }
  await markTaskItemRunning(context.task.id, context.item.id, "splitting");
  const batch = await prepareSceneBatch({
    client: dependencies.sceneClient,
    normalizedParentPath: stagingPath(context, dependencies),
    originalFilename: context.item.filename,
    workspaceRoot: dependencies.config.sceneDetectWorkspaceRoot,
    maximumSegmentBytes: dependencies.config.SCENE_SEGMENT_MAX_BYTES,
    concurrency: dependencies.config.SCENE_SEGMENT_CONCURRENCY,
  });
  const segmentPlans = new Map(
    batch.segments.map(
      (prepared) =>
        [
          prepared.index,
          {
            prepared,
            mediaId: crypto.randomUUID(),
            thumbnailMediaId: crypto.randomUUID(),
            segmentId: crypto.randomUUID(),
            assetId: crypto.randomUUID(),
            analysisJobId: crypto.randomUUID(),
          },
        ] as const,
    ),
  );
  const seededAnalysisJobIds = new Set<string>();
  let databaseCommitted = false;
  try {
    await markTaskItemRunning(context.task.id, context.item.id, "persisting");
    await persistSceneBatch({
      batch,
      storage: dependencies.storage,
      concurrency: dependencies.config.SCENE_PERSIST_CONCURRENCY,
      now: dependencies.now(),
      commitDatabase: async (persisted) => {
        const now = dependencies.now();
        const sourceId = crypto.randomUUID();
        const parentMediaId = crypto.randomUUID();
        const segmentRows = persisted.segments.map((segment) => {
          const plan = segmentPlans.get(segment.index);
          if (!plan) {
            throw new ScenePipelineError(
              "scene_persistence_failed",
              `分镜 ${segment.index} 缺少分析作业规划。`,
            );
          }
          return { segment, ...plan };
        });
        // analyze 作业一旦提交即可被其他 worker 领取，所以必须先原子准备好帧种子。
        const seedResults = await Promise.allSettled(
          segmentRows.map(async ({ analysisJobId, prepared }) => {
            await seedAnalysisVideoFrames(
              analysisJobId,
              ".mp4",
              prepared.analysisFramesDirectory,
              dependencies.config.mediaRoot,
            );
            seededAnalysisJobIds.add(analysisJobId);
          }),
        );
        const failedSeed = seedResults.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failedSeed) throw failedSeed.reason;
        // 整批父视频、切片对象、素材和分析作业在单个事务中同时可见。
        try {
          await db.transaction(async (tx) => {
          await tx.insert(mediaObjects).values([
            mediaObjectValues(
              parentMediaId,
              persisted.parentObject,
              "video/mp4",
              dependencies.config.ZOS_BUCKET,
              now,
            ),
            ...segmentRows.map(({ segment, mediaId }) =>
              mediaObjectValues(
                mediaId,
                segment.object,
                "video/mp4",
                dependencies.config.ZOS_BUCKET,
                now,
              ),
            ),
            ...segmentRows.map(({ segment, thumbnailMediaId }) =>
              mediaObjectValues(
                thumbnailMediaId,
                segment.thumbnailObject,
                "image/jpeg",
                dependencies.config.ZOS_BUCKET,
                now,
              ),
            ),
          ]);
          await tx.insert(videoSources).values({
            id: sourceId,
            taskId: context.task.id,
            taskItemId: context.item.id,
            userId: context.task.userId,
            mediaObjectId: parentMediaId,
            originalFilename: context.item.filename,
            mimeType: "video/mp4",
            sizeBytes: persisted.parentObject.sizeBytes,
            durationMs: Math.round(batch.durationSeconds * 1_000),
            status: "done",
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(taskItemSegments).values(
            segmentRows.map(({ segment, segmentId }) => ({
              id: segmentId,
              taskItemId: context.item.id,
              videoSourceId: sourceId,
              segmentIndex: segment.index,
              startMs: Math.round(segment.startSeconds * 1_000),
              endMs: Math.round(segment.endSeconds * 1_000),
              stagingPath: segment.object.key,
              mimeType: "video/mp4",
              sizeBytes: segment.object.sizeBytes,
              status: "done" as const,
              createdAt: now,
              updatedAt: now,
            })),
          );
          await tx.insert(assets).values(
            segmentRows.map(
              ({ segment, mediaId, thumbnailMediaId, segmentId, assetId }) => ({
                id: assetId,
                userId: context.task.userId,
                taskId: context.task.id,
                taskItemId: context.item.id,
                taskItemSegmentId: segmentId,
                videoSourceId: sourceId,
                mediaObjectId: mediaId,
                thumbnailMediaObjectId: thumbnailMediaId,
                segmentIndex: segment.index,
                segmentStartMs: Math.round(segment.startSeconds * 1_000),
                segmentEndMs: Math.round(segment.endSeconds * 1_000),
                name: `${baseName(context.item.filename)} - 分镜 ${segment.index}`,
                description: "",
                mediaType: "video" as const,
                originalFilename: `segment-${String(segment.index).padStart(3, "0")}.mp4`,
                originalPath: segment.object.key,
                mimeType: "video/mp4",
                sizeBytes: segment.object.sizeBytes,
                directPublish: context.autoPublish,
                processingStatus: "analyzing" as const,
                reviewStatus: "pending_review" as const,
                createdAt: now,
                updatedAt: now,
              }),
            ),
          );
          await tx.insert(jobs).values(
            segmentRows.map(({ assetId, analysisJobId }) => ({
              id: analysisJobId,
              taskId: context.task.id,
              assetId,
              type: "analyze" as const,
              phase: "analyzing",
              availableAt: now,
              createdAt: now,
              updatedAt: now,
            })),
          );
          await tx
            .update(jobs)
            .set({ status: "done", updatedAt: now })
            .where(
              and(
                eq(jobs.id, job.id),
                eq(jobs.status, "running"),
                eq(jobs.attempt, job.attempt),
              ),
            );
          await tx
            .update(taskItems)
            .set({
              mediaType: "video",
              status: "running",
              phase: "analyzing",
              updatedAt: now,
            })
            .where(eq(taskItems.id, context.item.id));
          });
          databaseCommitted = true;
        } catch (error) {
          await Promise.all(
            [...seededAnalysisJobIds].map((jobId) =>
              removeAnalysisWorkspace(jobId, dependencies.config.mediaRoot),
            ),
          );
          seededAnalysisJobIds.clear();
          throw error;
        }
      },
    });
  } finally {
    if (!databaseCommitted) {
      await Promise.all(
        [...seededAnalysisJobIds].map((jobId) =>
          removeAnalysisWorkspace(jobId, dependencies.config.mediaRoot),
        ),
      ).catch((error) => {
        console.error("视频批次失败后分析关键帧清理失败。", error);
      });
    }
    await cleanupPreparedSceneBatch(batch, dependencies.sceneClient).catch(
      (error) => {
        console.error("视频批次已终止，但本地或分镜服务副本清理失败。", error);
      },
    );
  }
}

/** 处理封存后的单个文件；上传成功后本地 staging 文件会立即回收。 */
export async function processValidateJob(
  job: ClaimedJob,
  dependencies: UploadPipelineDependencies = defaultDependencies(),
) {
  let context: UploadContext | undefined;
  try {
    context = await uploadContext(job);
    if (await alreadyPersisted(context.item.id)) {
      await removeStagingFile(stagingPath(context, dependencies));
      await completeJob(job);
      await markTaskItemPersisted(context.task.id, context.item.id);
      return;
    }
    await markTaskItemRunning(context.task.id, context.item.id, "validating");
    const validated = await validateMediaFile(
      stagingPath(context, dependencies),
      context.item.filename,
    );
    if (validated.mediaType === "image") {
      await processImage(job, context, validated, dependencies);
    } else {
      await processVideo(job, context, dependencies);
    }
    await removeStagingFile(stagingPath(context, dependencies)).catch((error) => {
      console.error("持久化成功，但本地 staging 文件清理失败。", error);
    });
  } catch (error) {
    await failJob(job);
    const failedItemId = context?.item.id ??
      (typeof job.payload?.taskItemId === "string"
        ? job.payload.taskItemId
        : undefined);
    if (failedItemId && job.taskId) {
      await failTaskItem(job.taskId, failedItemId, error);
      return;
    }
    throw error;
  }
}
