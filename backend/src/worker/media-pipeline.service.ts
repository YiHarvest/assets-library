import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { Analyzer } from "../analysis/analyzer";
import { displayDimensions } from "../analysis/image-dimensions";
import type { AnalysisResult } from "../analysis/analysis.types";
import { createVideoCover, normalizeVideoToH264, probeVideo, sampleVideoFrames } from "../analysis/media-tools";
import { loadConfig } from "../config";
import { DatabaseService } from "../database/database.service";
import { analysisResults, assets, assetTags, jobs, mediaObjects, tags, taskFiles, tasks, videoSources } from "../database/schema";
import { SceneClient, sceneSegmentSchema } from "../scene/scene.client";
import { ChromaClient } from "../search/chroma.client";
import { ZosService } from "../storage/zos.service";
import { assertUploadObjectSize } from "../services/upload-size-policy";
import { PublicationService } from "./publication.service";
import { shouldScheduleVideoFinalize } from "./video-job-policy";

function analysisTags(result: AnalysisResult) {
  const values = Object.values(result.tags).flat();
  return result.kind === "video" ? [...result.topics, ...values] : values;
}

export class MediaPipelineService {
  private readonly config = loadConfig();
  private readonly analyzer = new Analyzer();
  private readonly scene = new SceneClient();
  private readonly chroma = new ChromaClient();
  private readonly publication: PublicationService;

  constructor(private readonly database: DatabaseService, private readonly zos: ZosService) {
    this.publication = new PublicationService(database, zos);
  }

  async processTaskFile(taskFileId: string, signal?: AbortSignal) {
    const file = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
    if (!file?.uploadObjectId) throw new Error("上传文件记录不完整。");
    const [task, object] = await Promise.all([
      this.database.db.query.tasks.findFirst({ where: eq(tasks.id, file.taskId) }),
      this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, file.uploadObjectId!) }),
    ]);
    if (!task || !object) throw new Error("上传任务或 ZOS 对象不存在。");
    await this.database.db.update(taskFiles).set({ status: "running", phase: "processing", updatedAt: new Date() }).where(eq(taskFiles.id, file.id));
    const head = await this.zos.head(object.objectKey, signal);
    assertUploadObjectSize(file.mediaType, head.sizeBytes, this.config.MAX_IMAGE_BYTES, this.config.MAX_VIDEO_BYTES);
    if (head.sizeBytes !== object.sizeBytes && object.sizeBytes > 0) throw new Error("ZOS HEAD 大小与上传完成信息不一致。");
    const bytes = await this.zos.getBuffer(object.objectKey, signal);
    if (file.mediaType === "image") await this.processImage(file, task, object, bytes, signal);
    else await this.prepareVideo(file, task, bytes, signal);
  }

  private async processImage(file: typeof taskFiles.$inferSelect, task: typeof tasks.$inferSelect, object: typeof mediaObjects.$inferSelect, bytes: Buffer, signal?: AbortSignal) {
    if (bytes.byteLength > this.config.MAX_IMAGE_BYTES) throw new Error("图片超过 20 MiB 限制。");
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("图片损坏或格式不受支持。");
    await image.stats();
    const { width: displayWidth, height: displayHeight } = displayDimensions(metadata.width, metadata.height, metadata.orientation);
    const realMimeType = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
    const outcome = await this.analyzer.analyze({ mediaType: "image", mimeType: realMimeType, images: [{ bytes }] }, signal);
    const assetId = file.fileId ?? randomUUID();
    const extension = metadata.format === "jpeg" ? "jpg" : metadata.format!;
    const fileName = file.fileName === assetId ? `${assetId}.${extension}` : file.fileName;
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      await tx.update(mediaObjects).set({ sizeBytes: bytes.byteLength, mimeType: realMimeType, updatedAt: now }).where(eq(mediaObjects.id, object.id));
      await tx.insert(assets).values({ id: assetId, taskId: task.id, taskFileId: file.id, mediaObjectId: object.id, userId: task.userId, fileName, mediaType: "image", description: outcome.result.description, sizeBytes: bytes.byteLength, width: displayWidth, height: displayHeight, status: "pending_review", phase: "pending_review", createdAt: now, updatedAt: now }).onDuplicateKeyUpdate({ set: { fileName, description: outcome.result.description, width: displayWidth, height: displayHeight, status: "pending_review", phase: "pending_review", errorCode: null, errorMessage: null, updatedAt: now } });
      await this.persistAnalysis(tx, assetId, outcome.result, outcome.protocol, outcome.model, now);
      await tx.insert(jobs).ignore().values(this.embeddingJob(assetId, task.id, now));
      await tx.update(taskFiles).set({ fileId: assetId, fileName, sizeBytes: bytes.byteLength, status: "pending_review", phase: "pending_review", errorCode: null, errorMessage: null, updatedAt: now }).where(eq(taskFiles.id, file.id));
    });
    if (task.autoPublish) {
      await this.publication.publish(assetId, false, task.userId, signal);
      await this.database.db.update(taskFiles).set({ status: "done", phase: "published", updatedAt: new Date() }).where(eq(taskFiles.id, file.id));
    }
  }

  /**
   * validate 只负责校验父视频和创建切片作业。切片的转码、抽帧和 VLM 分析
   * 由独立 analyze_segment 作业执行，因此同一父视频可被多个 worker 并行处理。
   */
  private async prepareVideo(file: typeof taskFiles.$inferSelect, task: typeof tasks.$inferSelect, sourceBytes: Buffer, signal?: AbortSignal) {
    if (sourceBytes.byteLength > this.config.MAX_VIDEO_BYTES) throw new Error("视频超过大小限制。");
    if (!file.videoSourceId) throw new Error("父视频 ID 不存在。");
    const existingJobs = await this.database.db.query.jobs.findMany({
      where: and(eq(jobs.videoSourceId, file.videoSourceId), eq(jobs.type, "analyze_segment")),
    });
    if (existingJobs.length) {
      const failedIds = existingJobs.filter((job) => job.status === "failed").map((job) => job.id);
      if (failedIds.length) {
        await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: new Date(), updatedAt: new Date() }).where(inArray(jobs.id, failedIds));
      }
      await this.markVideoProcessing(file.id, file.videoSourceId);
      await this.enqueueVideoFinalizeIfReady(file.id, task.id, file.videoSourceId);
      return;
    }
    await probeVideo(sourceBytes, false, signal);
    const manifest = await this.scene.split(sourceBytes, `${file.videoSourceId ?? file.id}.mp4`, signal);
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      await tx.update(videoSources).set({ durationMs: Math.round(manifest.durationSeconds * 1000), sizeBytes: sourceBytes.byteLength, status: "running", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId!));
      await tx.update(taskFiles).set({ sizeBytes: sourceBytes.byteLength, status: "running", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(taskFiles.id, file.id));
      await tx.insert(jobs).ignore().values(manifest.segments.sort((a, b) => a.index - b.index).map((segment) => {
        const assetId = randomUUID();
        return {
          id: randomUUID(), taskId: task.id, fileId: assetId, videoSourceId: file.videoSourceId,
          type: "analyze_segment" as const, status: "queued" as const,
          dedupeKey: `video-segment:${file.videoSourceId}:${segment.index}`,
          payload: { task_file_id: file.id, segment },
          availableAt: now, createdAt: now, updatedAt: now,
        };
      }));
    });
  }

  async processVideoSegment(taskFileId: string, assetId: string, rawSegment: unknown, signal?: AbortSignal) {
    const segment = sceneSegmentSchema.parse(rawSegment);
    const file = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
    if (!file?.videoSourceId) throw new Error("切片作业缺少父视频任务文件。");
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, file.taskId) });
    if (!task) throw new Error("切片作业对应的上传任务不存在。");
    const existing = await this.database.db.query.assets.findFirst({ where: eq(assets.id, assetId) });
    if (existing?.coverObjectId && ["pending_review", "published"].includes(existing.phase)) {
      await this.enqueueEmbedding(assetId, task.id);
      return;
    }

    let bytes = await this.scene.download(segment, signal);
    let probe = await probeVideo(bytes, false, signal);
    if (!probe.browserCompatible) {
      bytes = await normalizeVideoToH264(bytes, signal);
      probe = await probeVideo(bytes, true, signal);
    }
    if (bytes.byteLength > this.config.SCENE_SEGMENT_MAX_BYTES) throw new Error(`切片 ${segment.index} 转码后超过大小限制。`);
    const cover = await createVideoCover(bytes, signal);
    const coverMetadata = await sharp(cover, { failOn: "error" }).metadata();
    if (!coverMetadata.width || !coverMetadata.height) throw new Error(`切片 ${segment.index} 封面分辨率无效。`);
    const frames = await sampleVideoFrames(bytes, probe.durationSeconds, 5, signal);
    const analysis = await this.analyzer.analyze({ mediaType: "video", mimeType: "video/mp4", images: frames }, signal);
    const mediaObjectId = randomUUID(); const coverObjectId = randomUUID();
    const mediaKey = this.zos.temporaryKey(assetId, "mp4"); const coverKey = this.zos.temporaryKey(`${assetId}-cover`, "jpg");
    const uploads = await Promise.allSettled([
      this.zos.put(mediaKey, bytes, "video/mp4", signal),
      this.zos.put(coverKey, cover, "image/jpeg", signal),
    ]);
    const uploadFailure = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (uploadFailure) {
      await Promise.allSettled([this.zos.delete(mediaKey), this.zos.delete(coverKey)]);
      throw uploadFailure.reason;
    }
    try {
      const now = new Date();
      await this.database.db.transaction(async (tx) => {
        await tx.insert(mediaObjects).values([
          { id: mediaObjectId, bucket: this.zos.bucket, objectKey: mediaKey, publicUrl: this.zos.publicUrl(mediaKey), mimeType: "video/mp4", sizeBytes: bytes.byteLength, storageClass: "temporary", createdAt: now, updatedAt: now },
          { id: coverObjectId, bucket: this.zos.bucket, objectKey: coverKey, publicUrl: this.zos.publicUrl(coverKey), mimeType: "image/jpeg", sizeBytes: cover.byteLength, storageClass: "temporary", createdAt: now, updatedAt: now },
        ]);
        await tx.insert(assets).values({ id: assetId, taskId: task.id, taskFileId: file.id, videoSourceId: file.videoSourceId, mediaObjectId, coverObjectId, userId: task.userId, fileName: `${assetId}.mp4`, mediaType: "video", description: analysis.result.description, sizeBytes: bytes.byteLength, durationMs: Math.round((segment.endSeconds - segment.startSeconds) * 1000), segmentStartMs: Math.round(segment.startSeconds * 1000), segmentEndMs: Math.round(segment.endSeconds * 1000), segmentOrder: segment.index, status: "pending_review", phase: "pending_review", createdAt: now, updatedAt: now });
        await this.persistAnalysis(tx, assetId, analysis.result, analysis.protocol, analysis.model, now);
        await tx.insert(jobs).ignore().values(this.embeddingJob(assetId, task.id, now));
      });
    } catch (error) {
      await Promise.allSettled([this.zos.delete(mediaKey), this.zos.delete(coverKey)]);
      throw error;
    }
  }

  async enqueueVideoFinalizeIfReady(taskFileId: string, taskId: string, videoSourceId: string) {
    const segmentJobs = await this.database.db.query.jobs.findMany({ where: and(eq(jobs.videoSourceId, videoSourceId), eq(jobs.type, "analyze_segment")) });
    const now = new Date();
    const dedupeKey = `video-finalize:${taskFileId}`;
    const existing = await this.database.db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, dedupeKey) });
    if (!shouldScheduleVideoFinalize(segmentJobs, existing)) return false;
    if (existing) {
      await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: now, updatedAt: now }).where(eq(jobs.id, existing.id));
      return true;
    }
    await this.database.db.insert(jobs).ignore().values({ id: randomUUID(), taskId, videoSourceId, type: "finalize", status: "queued", dedupeKey, payload: { task_file_id: taskFileId }, availableAt: now, createdAt: now, updatedAt: now });
    return true;
  }

  async finalizeVideo(taskFileId: string, signal?: AbortSignal) {
    const file = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
    if (!file?.videoSourceId) throw new Error("视频汇总作业缺少父视频任务文件。");
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, file.taskId) });
    if (!task) throw new Error("视频汇总作业对应的上传任务不存在。");
    const segmentJobs = await this.database.db.query.jobs.findMany({ where: and(eq(jobs.videoSourceId, file.videoSourceId), eq(jobs.type, "analyze_segment")) });
    if (!segmentJobs.length || segmentJobs.some((job) => job.status === "queued" || job.status === "running")) throw new Error("视频切片尚未全部处理完成。");
    const now = new Date();
    const failed = segmentJobs.filter((job) => job.status === "failed");
    if (failed.length) {
      const message = `${failed.length} 个视频切片处理失败，可重试失败切片。`;
      await this.database.db.update(taskFiles).set({ status: "failed", phase: "processing", errorCode: "segment_processing_failed", errorMessage: message, updatedAt: now }).where(and(eq(taskFiles.videoSourceId, file.videoSourceId), inArray(taskFiles.status, ["queued", "running", "failed"])));
      await this.database.db.update(videoSources).set({ status: "failed", phase: "processing", errorCode: "segment_processing_failed", errorMessage: message, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
      return;
    }
    const slices = await this.database.db.query.assets.findMany({ where: eq(assets.videoSourceId, file.videoSourceId) });
    if (slices.length !== segmentJobs.length || slices.some((slice) => !slice.coverObjectId)) throw new Error("视频切片结果数量或封面不完整。");
    if (task.autoPublish) {
      await this.publication.publish(slices[0]!.id, true, task.userId, signal);
      await this.database.db.update(taskFiles).set({ status: "done", phase: "published", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(and(eq(taskFiles.videoSourceId, file.videoSourceId), inArray(taskFiles.status, ["queued", "running", "failed"])));
      await this.database.db.update(videoSources).set({ status: "done", phase: "published", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
    } else {
      const allPublished = slices.every((slice) => slice.phase === "published");
      const state = allPublished
        ? { status: "done" as const, phase: "published" as const }
        : { status: "pending_review" as const, phase: "pending_review" as const };
      await this.database.db.update(taskFiles).set({ ...state, errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(and(eq(taskFiles.videoSourceId, file.videoSourceId), inArray(taskFiles.status, ["queued", "running", "failed"])));
      await this.database.db.update(videoSources).set({ ...state, errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
    }
  }

  async retryVideoSegments(taskFileId: string) {
    const file = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
    if (!file?.videoSourceId) throw new Error("父视频没有可恢复的切片作业。");
    const failed = await this.database.db.query.jobs.findMany({ where: and(eq(jobs.videoSourceId, file.videoSourceId), eq(jobs.type, "analyze_segment"), eq(jobs.status, "failed")) });
    if (!failed.length) return false;
    const now = new Date();
    await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: now, updatedAt: now }).where(inArray(jobs.id, failed.map((job) => job.id)));
    await this.markVideoProcessing(file.id, file.videoSourceId);
    return true;
  }

  private async markVideoProcessing(taskFileId: string, videoSourceId: string) {
    const now = new Date();
    await this.database.db.update(taskFiles).set({ status: "running", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(taskFiles.id, taskFileId));
    await this.database.db.update(videoSources).set({ status: "running", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, videoSourceId));
  }

  private async persistAnalysis(tx: Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0], assetId: string, result: AnalysisResult, protocol: string, model: string, now: Date) {
    await tx.insert(analysisResults).values({ assetId, resultJson: result, modelProtocol: protocol, modelName: model, completedAt: now }).onDuplicateKeyUpdate({ set: { resultJson: result, modelProtocol: protocol, modelName: model, completedAt: now, indexedAt: null, indexError: null } });
    for (const value of [...new Set(analysisTags(result).map((tag) => tag.trim()).filter(Boolean))]) {
      const normalized = value.toLocaleLowerCase(); const id = randomUUID();
      await tx.insert(tags).ignore().values({ id, value, normalizedValue: normalized, createdAt: now });
      const tag = await tx.query.tags.findFirst({ where: eq(tags.normalizedValue, normalized) });
      if (tag) await tx.insert(assetTags).ignore().values({ assetId, tagId: tag.id, source: "model" });
    }
  }

  private embeddingJob(assetId: string, taskId: string | null, now: Date) {
    return {
      id: randomUUID(),
      taskId,
      fileId: assetId,
      type: "embed" as const,
      status: "queued" as const,
      attempts: 0,
      dedupeKey: `asset-embed:${assetId}`,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 分析、编辑和维护共用的幂等 embed 入队入口。 */
  async enqueueEmbedding(assetId: string, taskId: string | null, force = false) {
    const [analysis, existing] = await Promise.all([
      this.database.db.query.analysisResults.findFirst({ where: eq(analysisResults.assetId, assetId) }),
      this.database.db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, `asset-embed:${assetId}`) }),
    ]);
    if (!analysis || (!force && analysis.indexedAt && !analysis.indexError)) return false;
    if (existing?.status === "queued" || existing?.status === "running") return false;
    const now = new Date();
    if (existing) {
      await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: now, updatedAt: now }).where(eq(jobs.id, existing.id));
      return true;
    }
    await this.database.db.insert(jobs).ignore().values(this.embeddingJob(assetId, taskId, now));
    return true;
  }

  async index(assetId: string) {
    const row = await this.database.db.query.analysisResults.findFirst({ where: eq(analysisResults.assetId, assetId) });
    if (!row) throw new Error("分析结果不存在。");
    const analysis = row.resultJson as AnalysisResult;
    try {
      await this.chroma.index(assetId, analysis);
      // hard delete 可能与已领取的 embed 并发：索引写入后再次以 MySQL 为准。
      // 素材已经删除时立即回收刚写入的派生向量，避免留下孤儿索引。
      const asset = await this.database.db.query.assets.findFirst({ where: eq(assets.id, assetId) });
      if (!asset) {
        await this.chroma.delete(assetId).catch(() => undefined);
        return false;
      }
      // 编辑与 embed 并发时只确认本次读取的分析版本；更新后的版本仍保持
      // indexed_at=null，由维护任务重新排队，避免旧向量覆盖新描述。
      await this.database.db.update(analysisResults).set({ indexedAt: new Date(), indexError: null }).where(and(eq(analysisResults.assetId, assetId), eq(analysisResults.completedAt, row.completedAt)));
    } catch (error) {
      await this.database.db.update(analysisResults).set({ indexError: error instanceof Error ? error.message.slice(0, 2000) : "索引失败" }).where(and(eq(analysisResults.assetId, assetId), eq(analysisResults.completedAt, row.completedAt)));
      throw error;
    }
    return true;
  }

  get publicationService() { return this.publication; }
  get chromaClient() { return this.chroma; }
}
