import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { MySqlRawQueryResult } from "drizzle-orm/mysql2";
import { db } from "@/server/db";
import { loadConfig } from "@/server/config";
import {
  analysisResults,
  assets,
  assetTagRejections,
  assetTags,
  jobs,
  mediaObjects,
  searchIndexState,
  tags,
  tasks,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import {
  analysisRelativePath,
  readVideoFrames,
  removeAnalysisWorkspace,
  removeAssetFiles,
  resolveMediaPath,
  storeVideoFrames,
} from "@/server/media/storage";
import { validateMediaFile } from "@/server/media/validate";
import { extractVideoFrames } from "@/server/media/video-frames";
import {
  OpenAICompatibleAnalyzer,
  type MultimodalAnalyzer,
} from "@/server/model/analyzer";
import {
  completeJob,
  failJob,
  getAssetRecord,
  heartbeatJob,
  requeueJob,
  type ClaimedJob,
} from "@/server/repositories/assets";
import { indexAnalysis, semanticSearchEnabled } from "@/server/search/chroma";
import { SceneDetectClient } from "@/server/scene/client";
import { processCallbackJob } from "@/server/services/callbacks";
import { processMutationJob } from "@/server/services/mutation-pipeline";
import {
  failMutationTask,
  finishMutationTask,
  refreshTaskForAsset,
} from "@/server/services/task-lifecycle";
import { processValidateJob } from "@/server/services/upload-pipeline";
import type { ObjectStorage } from "@/server/storage/object-storage";
import { createZosObjectStorage } from "@/server/storage/zos";
import {
  analysisResultSchema,
  type AnalysisResult,
  type FailureCode,
} from "@/shared/contracts";

type AssetRecord = NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>;
type MediaPreparer = (
  asset: AssetRecord,
) => Promise<{ mimeType: string; sizeBytes: number }>;
type VideoFramePreparer = (asset: AssetRecord) => Promise<void>;

export interface ProcessingRuntime {
  storage?: ObjectStorage;
  /** validate 作业可注入分镜客户端，便于在 CI 中稳定验证整条链路。 */
  sceneClient?: SceneDetectClient;
}

function isObjectStorage(
  value: ObjectStorage | ProcessingRuntime,
): value is ObjectStorage {
  return (
    !Object.hasOwn(value, "storage") &&
    !Object.hasOwn(value, "sceneClient") &&
    // 运行时对象应实现下列能力；单元测试可传入空的类型替身。
    ("storeFile" in value ||
      "headObject" in value ||
      "getObject" in value ||
      "downloadToFile" in value ||
      "deleteObject" in value ||
      Object.keys(value).length === 0)
  );
}

async function prepareMedia(asset: AssetRecord) {
  const validated = await validateMediaFile(
    resolveMediaPath(asset.originalPath),
    asset.originalFilename,
  );
  if (validated.mediaType !== asset.mediaType) {
    throw new AppError("unsupported_media_type");
  }
  return { mimeType: validated.mimeType, sizeBytes: validated.sizeBytes };
}

async function prepareVideoFrames(asset: AssetRecord) {
  try {
    readVideoFrames(asset.originalPath);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "video_frames_missing") {
      throw error;
    }
    const extracted = await extractVideoFrames(resolveMediaPath(asset.originalPath));
    storeVideoFrames(asset.originalPath, extracted.uploads, extracted.metadata);
  }
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

function tagsFromAnalysis(result: AnalysisResult) {
  if (result.kind === "image") {
    return Object.entries(result.tags).flatMap(([category, values]) =>
      values.map((value) => ({ category, value })),
    );
  }
  return [
    ...result.topics.map((value) => ({ category: "topic", value })),
    ...Object.entries(result.tags).flatMap(([category, values]) =>
      values.map((value) => ({ category, value })),
    ),
  ];
}

function affectedRows(result: MySqlRawQueryResult) {
  return result[0].affectedRows;
}

async function advanceJobAssetStatus(
  job: ClaimedJob,
  processingStatus: "validating" | "analyzing",
) {
  if (!job.assetId) return false;
  const assetId = job.assetId;
  const now = new Date();
  return db.transaction(async (tx) => {
    const renewed = await tx
      .update(jobs)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "running"),
          eq(jobs.attempt, job.attempt),
        ),
      );
    if (affectedRows(renewed) !== 1) return false;
    const updated = await tx
      .update(assets)
      .set({ processingStatus, updatedAt: now })
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.reviewStatus, "pending_review"),
        ),
      );
    return affectedRows(updated) === 1;
  });
}

async function persistAnalysis(
  job: ClaimedJob,
  result: AnalysisResult,
  protocol: string,
  modelName: string,
) {
  if (!job.assetId) return false;
  const assetId = job.assetId;
  const now = new Date();
  return db.transaction(async (tx) => {
    const completed = await tx
      .update(jobs)
      .set({ status: "done", updatedAt: now })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "running"),
          eq(jobs.attempt, job.attempt),
        ),
      );
    if (affectedRows(completed) !== 1) return false;

    const [asset] = await tx
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!asset || asset.reviewStatus === "deleted") return true;

    await tx
      .insert(analysisResults)
      .values({
        assetId,
        schemaVersion: 1,
        resultJson: result,
        modelProtocol: protocol,
        modelName,
        completedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { resultJson: result, modelProtocol: protocol, modelName, completedAt: now },
      });

    const rejected = await tx
      .select()
      .from(assetTagRejections)
      .where(eq(assetTagRejections.assetId, assetId));
    const rejectedKeys = new Set(
      rejected.map((item) => `${item.category}:${item.normalizedValue}`),
    );
    for (const tag of tagsFromAnalysis(result)) {
      const normalizedValue = normalize(tag.value);
      if (rejectedKeys.has(`${tag.category}:${normalizedValue}`)) continue;
      await tx
        .insert(tags)
        .ignore()
        .values({
          id: crypto.randomUUID(),
          category: tag.category,
          value: tag.value.trim(),
          normalizedValue,
          createdAt: now,
        });
      const [storedTag] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(
            eq(tags.category, tag.category),
            eq(tags.normalizedValue, normalizedValue),
          ),
        )
        .limit(1);
      if (!storedTag) throw new Error("标签创建后无法读取。");
      await tx
        .insert(assetTags)
        .ignore()
        .values({
          assetId,
          tagId: storedTag.id,
          source: "model",
          confidence: null,
        });
    }
    await tx
      .update(assets)
      .set({
        description: asset.description || result.description,
        processingStatus: "completed",
        reviewStatus: asset.directPublish ? "published" : "pending_review",
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(assets.id, assetId));
    if (semanticSearchEnabled()) {
      await tx.insert(jobs).values({
        id: crypto.randomUUID(),
        taskId: job.taskId,
        assetId,
        type: "embed",
        status: "queued",
        phase: "analyzing",
        attempt: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .insert(searchIndexState)
        .values({ assetId, status: "queued", updatedAt: now })
        .onDuplicateKeyUpdate({ set: { status: "queued", errorMessage: null, updatedAt: now } });
    }
    return true;
  });
}

async function failJobAndMarkAsset(job: ClaimedJob, error: unknown) {
  const appError = error instanceof AppError ? error : new AppError("internal_error");
  const now = new Date();
  return db.transaction(async (tx) => {
    const failed = await tx
      .update(jobs)
      .set({
        status: "failed",
        errorCode: appError.code,
        errorMessage: appError.message,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "running"),
          eq(jobs.attempt, job.attempt),
        ),
      );
    if (affectedRows(failed) !== 1) return false;
    if (!job.assetId) return true;
    await tx
      .update(assets)
      .set({
        processingStatus: "failed",
        failureCode: appError.code satisfies FailureCode,
        failureMessage: appError.message,
        updatedAt: now,
      })
      .where(and(eq(assets.id, job.assetId), eq(assets.reviewStatus, "pending_review")));
    return true;
  });
}

async function taskType(taskId: string | null) {
  if (!taskId) return null;
  const [task] = await db
    .select({ type: tasks.type })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return task?.type ?? null;
}

async function finishAnalysisLifecycle(job: ClaimedJob, failed?: unknown) {
  if (!job.assetId) return;
  if (job.taskId && (await taskType(job.taskId)) === "retry") {
    if (failed) await failMutationTask(job.taskId, failed);
    else await finishMutationTask(job.taskId, { asset_id: job.assetId });
    return;
  }
  await refreshTaskForAsset(job.assetId);
}

async function hydratedAsset(
  asset: AssetRecord,
  job: ClaimedJob,
  storage?: ObjectStorage,
) {
  if (asset.mediaType === "video") {
    const extension = path.extname(asset.originalFilename).toLowerCase() || ".mp4";
    const relativePath = analysisRelativePath(job.id, extension);
    try {
      readVideoFrames(relativePath);
      const absolutePath = resolveMediaPath(relativePath);
      return {
        asset: { ...asset, originalPath: relativePath },
        workspace: path.dirname(absolutePath),
        precomputedFrames: true,
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "video_frames_missing") {
        throw error;
      }
    }
  }
  if (!asset.mediaObjectId) {
    return { asset, workspace: null, precomputedFrames: false };
  }
  const [object] = await db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, asset.mediaObjectId))
    .limit(1);
  if (!object || object.status !== "persisted") {
    throw new AppError("storage_error", "素材的持久化对象不存在。", 500);
  }
  if (object.provider === "local") {
    return { asset, workspace: null, precomputedFrames: false };
  }
  const extension = path.extname(asset.originalFilename).toLowerCase() || ".bin";
  const relativePath = path.posix.join(".analysis", job.id, `original${extension}`);
  const absolutePath = resolveMediaPath(relativePath);
  await (storage ?? createZosObjectStorage()).downloadToFile(
    object.objectKey,
    absolutePath,
  );
  return {
    asset: { ...asset, originalPath: relativePath },
    workspace: path.dirname(absolutePath),
    precomputedFrames: false,
  };
}

async function processEmbeddingJob(job: ClaimedJob) {
  if (!job.assetId) {
    await failJob(job);
    return;
  }
  const [analysis] = await db
    .select()
    .from(analysisResults)
    .where(eq(analysisResults.assetId, job.assetId))
    .limit(1);
  const asset = await getAssetRecord(job.assetId);
  if (!analysis || !asset || asset.reviewStatus === "deleted") {
    await completeJob(job);
    return;
  }
  try {
    await indexAnalysis(job.assetId, analysisResultSchema.parse(analysis.resultJson));
    await db
      .insert(searchIndexState)
      .values({
        assetId: job.assetId,
        status: "done",
        indexedAt: new Date(),
        updatedAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: { status: "done", indexedAt: new Date(), errorMessage: null, updatedAt: new Date() },
      });
    await completeJob(job);
  } catch (error) {
    if (job.attempt < 3) {
      await requeueJob(job, job.attempt * 30_000);
    } else {
      await db
        .insert(searchIndexState)
        .values({
          assetId: job.assetId,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "向量索引失败。",
          updatedAt: new Date(),
        })
        .onDuplicateKeyUpdate({
          set: {
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "向量索引失败。",
            updatedAt: new Date(),
          },
        });
      await failJob(job);
    }
  }
}

async function processAnalysisJob(
  job: ClaimedJob,
  analyzer: MultimodalAnalyzer,
  mediaPreparer: MediaPreparer,
  videoFramePreparer: VideoFramePreparer,
  storage?: ObjectStorage,
) {
  if (!job.assetId) {
    await removeAnalysisWorkspace(job.id).catch(() => undefined);
    await failJob(job);
    return;
  }
  const record = await getAssetRecord(job.assetId);
  if (!record) {
    await removeAnalysisWorkspace(job.id).catch(() => undefined);
    await failJob(job);
    return;
  }
  if (record.reviewStatus === "deleted") {
    await removeAnalysisWorkspace(job.id).catch(() => undefined);
    await completeJob(job);
    return;
  }
  let workspace: string | null = null;
  try {
    const hydrated = await hydratedAsset(record, job, storage);
    const asset = hydrated.asset;
    workspace = hydrated.workspace;
    if (!(await advanceJobAssetStatus(job, "validating"))) return;
    const prepared = hydrated.precomputedFrames
      ? { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes }
      : await mediaPreparer(asset);
    await db
      .update(assets)
      .set({ mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes, updatedAt: new Date() })
      .where(eq(assets.id, asset.id));
    if (asset.mediaType === "video" && !hydrated.precomputedFrames) {
      await videoFramePreparer(asset);
    }
    if (!(await advanceJobAssetStatus(job, "analyzing"))) return;
    const outcome = await analyzer.analyze({
      assetId: asset.id,
      mediaType: asset.mediaType,
      mimeType: prepared.mimeType,
      relativePath: asset.originalPath,
    });
    await persistAnalysis(job, outcome.result, outcome.model.protocol, outcome.model.name);
    await finishAnalysisLifecycle(job);
  } catch (error) {
    await failJobAndMarkAsset(job, error);
    await finishAnalysisLifecycle(job, error);
  } finally {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  }
}

/** worker 的统一作业分派入口。 */
export async function processJob(
  job: ClaimedJob,
  analyzer: MultimodalAnalyzer = new OpenAICompatibleAnalyzer(),
  mediaPreparer: MediaPreparer = prepareMedia,
  videoFramePreparer: VideoFramePreparer = prepareVideoFrames,
  storageOrRuntime?: ObjectStorage | ProcessingRuntime,
) {
  const runtime: ProcessingRuntime =
    storageOrRuntime && isObjectStorage(storageOrRuntime)
      ? { storage: storageOrRuntime }
      : (storageOrRuntime ?? {});
  const storage = runtime.storage;
  const heartbeat = setInterval(() => {
    void heartbeatJob(job).catch((error) => {
      console.error("Processing job heartbeat failed.", error);
    });
  }, 30_000);
  heartbeat.unref();
  try {
    if (job.type === "validate") {
      const config = loadConfig();
      await processValidateJob(job, {
        config,
        storage: storage ?? createZosObjectStorage(config),
        sceneClient:
          runtime.sceneClient ??
          new SceneDetectClient({
            baseUrl: config.SCENE_DETECT_BASE_URL,
            timeoutMs: config.SCENE_DETECT_TIMEOUT_MS,
            pollIntervalMs: config.SCENE_DETECT_POLL_INTERVAL_MS,
          }),
        now: () => new Date(),
      });
      return;
    }
    if (job.type === "analyze") {
      await processAnalysisJob(job, analyzer, mediaPreparer, videoFramePreparer, storage);
      return;
    }
    if (job.type === "embed") {
      await processEmbeddingJob(job);
      return;
    }
    if (["update", "publish", "retry", "delete"].includes(job.type)) {
      await processMutationJob(job, storage ?? createZosObjectStorage());
      return;
    }
    if (job.type === "callback") {
      await processCallbackJob(job);
      return;
    }
    if (job.type === "cleanup") {
      if (job.assetId) {
        const asset = await getAssetRecord(job.assetId);
        if (asset && !asset.mediaObjectId) removeAssetFiles(asset.originalPath);
      }
      await completeJob(job);
      return;
    }
    await failJob(job);
  } catch (error) {
    console.error(`Job ${job.id} (${job.type}) failed.`, error);
    await failJob(job);
  } finally {
    clearInterval(heartbeat);
  }
}
