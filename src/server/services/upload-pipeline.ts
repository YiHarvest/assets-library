import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import {
  assetEntries,
  jobs,
  mediaObjects,
  privateAssets,
  publicAssets,
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
import {
  prepareSceneBatch,
  cleanupPreparedSceneBatch,
  type PreparedSceneSegment,
} from "@/server/scene/batch";
import { SceneDetectClient } from "@/server/scene/client";
import { ScenePipelineError } from "@/server/scene/types";
import {
  completeJob,
  failJob,
  type ClaimedJob,
} from "@/server/repositories/assets";
import {
  persistSceneBatch,
  type PersistedSceneBatch,
} from "@/server/services/scene-persistence";
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

interface SegmentAnalysisPlan {
  prepared: PreparedSceneSegment;
  analysisJobId: string;
}

/**
 * 分析作业只有在帧工作区完整落盘后才能进入数据库；后续事务失败时也必须
 * 回收已经写入的工作区，避免留下永远不会被 worker 消费的孤儿目录。
 */
async function withSeededAnalysisWorkspaces<T>(
  plans: readonly SegmentAnalysisPlan[],
  mediaRoot: string,
  operation: () => Promise<T>,
) {
  const seededJobIds = new Set<string>();
  try {
    const seedResults = await Promise.allSettled(
      plans.map(async ({ analysisJobId, prepared }) => {
        await seedAnalysisVideoFrames(
          analysisJobId,
          ".mp4",
          prepared.analysisFramesDirectory,
          mediaRoot,
        );
        seededJobIds.add(analysisJobId);
      }),
    );
    const failedSeed = seedResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedSeed) throw failedSeed.reason;
    return await operation();
  } catch (error) {
    const cleanupResults = await Promise.allSettled(
      [...seededJobIds].map((jobId) =>
        removeAnalysisWorkspace(jobId, mediaRoot),
      ),
    );
    if (cleanupResults.some((result) => result.status === "rejected")) {
      console.error("视频分析关键帧工作区回滚不完整。");
    }
    throw error;
  }
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
  return row;
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
    .select({ id: assetEntries.id })
    .from(assetEntries)
    .where(eq(assetEntries.taskItemId, itemId))
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
  const publicAssetId = crypto.randomUUID();
  const privateAssetId = context.task.userId ? crypto.randomUUID() : null;
  const publicMediaObjectId = crypto.randomUUID();
  const privateMediaObjectId = privateAssetId ? crypto.randomUUID() : null;
  const prefix = `assets/images/${datePrefix(now)}/${context.task.id}/${context.item.id}`;
  const stored: StoredObject[] = [];
  try {
    stored.push(
      await dependencies.storage.storeFile({
        key: `${prefix}/public${validated.extension}`,
        filePath: stagingPath(context, dependencies),
        contentType: validated.mimeType,
      }),
    );
    if (privateAssetId) {
      stored.push(
        await dependencies.storage.storeFile({
          key: `${prefix}/private${validated.extension}`,
          filePath: stagingPath(context, dependencies),
          contentType: validated.mimeType,
        }),
      );
    }
    // ZOS 与 MySQL 无法共享事务：对象先写入，建档失败时立即补偿删除。
    await db.transaction(async (tx) => {
      await tx.insert(mediaObjects).values([
        mediaObjectValues(
          publicMediaObjectId,
          stored[0]!,
          validated.mimeType,
          dependencies.config.ZOS_BUCKET,
          now,
        ),
        ...(privateMediaObjectId
          ? [
              mediaObjectValues(
                privateMediaObjectId,
                stored[1]!,
                validated.mimeType,
                dependencies.config.ZOS_BUCKET,
                now,
              ),
            ]
          : []),
      ]);
      const common = {
        taskId: context.task.id,
        taskItemId: context.item.id,
        name: baseName(context.item.filename),
        description: "",
        mediaType: "image",
        originalFilename: context.item.filename,
        mimeType: validated.mimeType,
        processingStatus: "analyzing",
        createdAt: now,
        updatedAt: now,
      } as const;
      await tx.insert(publicAssets).values({
        ...common,
        id: publicAssetId,
        uploaderUserId: context.task.userId,
        mediaObjectId: publicMediaObjectId,
        originalPath: stored[0]!.key,
        sizeBytes: stored[0]!.sizeBytes,
        reviewStatus: "pending_review",
      });
      if (privateAssetId && privateMediaObjectId && context.task.userId) {
        await tx.insert(privateAssets).values({
          ...common,
          id: privateAssetId,
          publicAssetId,
          userId: context.task.userId,
          mediaObjectId: privateMediaObjectId,
          originalPath: stored[1]!.key,
          sizeBytes: stored[1]!.sizeBytes,
        });
      }
      await tx.insert(jobs).values({
        id: crypto.randomUUID(),
        taskId: context.task.id,
        ...(privateAssetId
          ? { privateAssetId, payload: { pairedPublicAssetId: publicAssetId } }
          : { publicAssetId }),
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
    await Promise.allSettled(
      stored.map((object) => dependencies.storage.deleteObject(object.key)),
    );
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
            segmentId: crypto.randomUUID(),
            publicMediaId: crypto.randomUUID(),
            publicThumbnailMediaId: crypto.randomUUID(),
            publicAssetId: crypto.randomUUID(),
            privateMediaId: context.task.userId ? crypto.randomUUID() : null,
            privateThumbnailMediaId: context.task.userId
              ? crypto.randomUUID()
              : null,
            privateAssetId: context.task.userId ? crypto.randomUUID() : null,
            analysisJobId: crypto.randomUUID(),
          },
        ] as const,
    ),
  );
  let persistedPublic: PersistedSceneBatch | undefined;

  const commitDatabase = async (
    publicBatch: PersistedSceneBatch,
    privateBatch?: PersistedSceneBatch,
  ) => {
    const now = dependencies.now();
    const sourceId = crypto.randomUUID();
    const publicParentMediaId = crypto.randomUUID();
    const privateParentMediaId = privateBatch ? crypto.randomUUID() : null;
    const segmentRows = publicBatch.segments.map((publicSegment) => {
      const plan = segmentPlans.get(publicSegment.index);
      const privateSegment = privateBatch?.segments.find(
        (candidate) => candidate.index === publicSegment.index,
      );
      if (!plan || (privateBatch && !privateSegment)) {
        throw new ScenePipelineError(
          "scene_persistence_failed",
          `分镜 ${publicSegment.index} 缺少公私副本规划。`,
        );
      }
      return { publicSegment, privateSegment, ...plan };
    });

    await withSeededAnalysisWorkspaces(
      segmentRows,
      dependencies.config.mediaRoot,
      async () => {
        await db.transaction(async (tx) => {
          await tx.insert(mediaObjects).values([
            mediaObjectValues(
              publicParentMediaId,
              publicBatch.parentObject,
              "video/mp4",
              dependencies.config.ZOS_BUCKET,
              now,
            ),
            ...segmentRows.flatMap((row) => [
              mediaObjectValues(
                row.publicMediaId,
                row.publicSegment.object,
                "video/mp4",
                dependencies.config.ZOS_BUCKET,
                now,
              ),
              mediaObjectValues(
                row.publicThumbnailMediaId,
                row.publicSegment.thumbnailObject,
                "image/jpeg",
                dependencies.config.ZOS_BUCKET,
                now,
              ),
            ]),
            ...(privateParentMediaId && privateBatch
              ? [
                  mediaObjectValues(
                    privateParentMediaId,
                    privateBatch.parentObject,
                    "video/mp4",
                    dependencies.config.ZOS_BUCKET,
                    now,
                  ),
                  ...segmentRows.flatMap((row) => [
                    mediaObjectValues(
                      row.privateMediaId!,
                      row.privateSegment!.object,
                      "video/mp4",
                      dependencies.config.ZOS_BUCKET,
                      now,
                    ),
                    mediaObjectValues(
                      row.privateThumbnailMediaId!,
                      row.privateSegment!.thumbnailObject,
                      "image/jpeg",
                      dependencies.config.ZOS_BUCKET,
                      now,
                    ),
                  ]),
                ]
              : []),
          ]);
          await tx.insert(videoSources).values({
            id: sourceId,
            taskId: context.task.id,
            taskItemId: context.item.id,
            userId: context.task.userId,
            publicMediaObjectId: publicParentMediaId,
            privateMediaObjectId: privateParentMediaId,
            originalFilename: context.item.filename,
            mimeType: "video/mp4",
            sizeBytes: publicBatch.parentObject.sizeBytes,
            durationMs: Math.round(batch.durationSeconds * 1_000),
            generatedSegmentCount: segmentRows.length,
            status: "done",
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(taskItemSegments).values(
            segmentRows.map(({ publicSegment, segmentId }) => ({
              id: segmentId,
              taskItemId: context.item.id,
              videoSourceId: sourceId,
              segmentIndex: publicSegment.index,
              startMs: Math.round(publicSegment.startSeconds * 1_000),
              endMs: Math.round(publicSegment.endSeconds * 1_000),
              stagingPath: publicSegment.object.key,
              mimeType: "video/mp4",
              sizeBytes: publicSegment.object.sizeBytes,
              status: "done" as const,
              createdAt: now,
              updatedAt: now,
            })),
          );
          await tx.insert(publicAssets).values(
            segmentRows.map(({ publicSegment, segmentId, publicMediaId, publicThumbnailMediaId, publicAssetId }) => ({
              id: publicAssetId,
              uploaderUserId: context.task.userId,
              taskId: context.task.id,
              taskItemId: context.item.id,
              taskItemSegmentId: segmentId,
              videoSourceId: sourceId,
              mediaObjectId: publicMediaId,
              thumbnailMediaObjectId: publicThumbnailMediaId,
              segmentIndex: publicSegment.index,
              segmentStartMs: Math.round(publicSegment.startSeconds * 1_000),
              segmentEndMs: Math.round(publicSegment.endSeconds * 1_000),
              name: `${baseName(context.item.filename)} - 分镜 ${publicSegment.index}`,
              description: "",
              mediaType: "video" as const,
              originalFilename: `segment-${String(publicSegment.index).padStart(3, "0")}.mp4`,
              originalPath: publicSegment.object.key,
              mimeType: "video/mp4",
              sizeBytes: publicSegment.object.sizeBytes,
              processingStatus: "analyzing" as const,
              reviewStatus: "pending_review" as const,
              createdAt: now,
              updatedAt: now,
            })),
          );
          if (privateBatch && context.task.userId) {
            await tx.insert(privateAssets).values(
              segmentRows.map((row) => ({
                id: row.privateAssetId!,
                publicAssetId: row.publicAssetId,
                userId: context.task.userId!,
                taskId: context.task.id,
                taskItemId: context.item.id,
                taskItemSegmentId: row.segmentId,
                videoSourceId: sourceId,
                mediaObjectId: row.privateMediaId!,
                thumbnailMediaObjectId: row.privateThumbnailMediaId!,
                segmentIndex: row.privateSegment!.index,
                segmentStartMs: Math.round(row.privateSegment!.startSeconds * 1_000),
                segmentEndMs: Math.round(row.privateSegment!.endSeconds * 1_000),
                name: `${baseName(context.item.filename)} - 分镜 ${row.privateSegment!.index}`,
                description: "",
                mediaType: "video" as const,
                originalFilename: `segment-${String(row.privateSegment!.index).padStart(3, "0")}.mp4`,
                originalPath: row.privateSegment!.object.key,
                mimeType: "video/mp4",
                sizeBytes: row.privateSegment!.object.sizeBytes,
                processingStatus: "analyzing" as const,
                createdAt: now,
                updatedAt: now,
              })),
            );
          }
          await tx.insert(jobs).values(
            segmentRows.map((row) => ({
              id: row.analysisJobId,
              taskId: context.task.id,
              ...(row.privateAssetId
                ? {
                    privateAssetId: row.privateAssetId,
                    payload: { pairedPublicAssetId: row.publicAssetId },
                  }
                : { publicAssetId: row.publicAssetId }),
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
      },
    );
  };

  try {
    await markTaskItemRunning(context.task.id, context.item.id, "persisting");
    persistedPublic = await persistSceneBatch({
      batch,
      storage: dependencies.storage,
      concurrency: dependencies.config.SCENE_PERSIST_CONCURRENCY,
      now: dependencies.now(),
      variant: "public",
      commitDatabase: context.task.userId
        ? async () => undefined
        : (persisted) => commitDatabase(persisted),
    });
    if (context.task.userId) {
      await persistSceneBatch({
        batch,
        storage: dependencies.storage,
        concurrency: dependencies.config.SCENE_PERSIST_CONCURRENCY,
        now: dependencies.now(),
        variant: "private",
        commitDatabase: (persistedPrivate) =>
          commitDatabase(persistedPublic!, persistedPrivate),
      });
    }
  } catch (error) {
    if (persistedPublic && context.task.userId) {
      await Promise.allSettled([
        dependencies.storage.deleteObject(persistedPublic.parentObject.key),
        ...persistedPublic.segments.flatMap((segment) => [
          dependencies.storage.deleteObject(segment.object.key),
          dependencies.storage.deleteObject(segment.thumbnailObject.key),
        ]),
      ]);
    }
    throw error;
  } finally {
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
