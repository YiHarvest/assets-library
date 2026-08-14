import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { loadConfig } from "../config";
import { DatabaseService } from "../database/database.service";
import { analysisResults, assets, assetTags, jobs, mediaObjects, tags, taskFiles, tasks, videoSources } from "../database/schema";
import { ZosService } from "../storage/zos.service";
import { MediaPipelineService } from "./media-pipeline.service";
import { canDeleteOrphanVideoSource, canEditPersonalAsset, deleteDerivedIndexBestEffort } from "./mutation-policy";
import { workerLog } from "./logger";
import { deletionScopeMatches, isFailedProcessingTarget, requestedDeletionUserId, uniqueObjectIds } from "./delete-policy";
import { aggregateUploadTask, purgeAtForState } from "./task-state";

export class MutationService {
  private readonly config = loadConfig();
  constructor(private readonly database: DatabaseService, private readonly zos: ZosService, private readonly pipeline: MediaPipelineService) {}

  async update(payload: Record<string, unknown>) {
    const fileId = String(payload.file_id ?? ""); const userId = String(payload.user_id ?? "");
    const asset = await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) });
    if (!asset || !canEditPersonalAsset(asset, userId)) throw new Error("只能编辑本人待入库或已入库素材。");
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      await tx.update(assets).set({ ...(typeof payload.file_name === "string" ? { fileName: payload.file_name } : {}), ...(typeof payload.description === "string" ? { description: payload.description } : {}), updatedAt: now }).where(eq(assets.id, fileId));
      if (Array.isArray(payload.tags)) {
        await tx.delete(assetTags).where(eq(assetTags.assetId, fileId));
        for (const raw of payload.tags) {
          const value = String(raw).trim(); const normalized = value.toLocaleLowerCase();
          await tx.insert(tags).ignore().values({ id: randomUUID(), value, normalizedValue: normalized, createdAt: now });
          const tag = await tx.query.tags.findFirst({ where: eq(tags.normalizedValue, normalized) });
          if (tag) await tx.insert(assetTags).ignore().values({ assetId: fileId, tagId: tag.id, source: "human" });
        }
      }
      if (typeof payload.description === "string") {
        const row = await tx.query.analysisResults.findFirst({ where: eq(analysisResults.assetId, fileId) });
        if (row) await tx.update(analysisResults).set({ resultJson: { ...row.resultJson, description: payload.description }, completedAt: now, indexedAt: null, indexError: null }).where(eq(analysisResults.assetId, fileId));
      }
    });
    const analysis = await this.database.db.query.analysisResults.findFirst({ where: eq(analysisResults.assetId, fileId) });
    if (analysis) await this.pipeline.enqueueEmbedding(fileId, asset.taskId, true);
    return { status: "done" as const, phase: "published" as const };
  }

  async publish(payload: Record<string, unknown>, signal?: AbortSignal) {
    const fileId = String(payload.file_id ?? "");
    await this.pipeline.publicationService.publish(fileId, false, typeof payload.user_id === "string" ? payload.user_id : null, signal);
    return { status: "done" as const, phase: "published" as const };
  }

  async retry(payload: Record<string, unknown>, signal?: AbortSignal) {
    const fileId = typeof payload.file_id === "string" ? payload.file_id : null;
    const sourceId = typeof payload.video_source_id === "string" ? payload.video_source_id : null;
    if (sourceId) {
      const source = await this.database.db.query.videoSources.findFirst({ where: eq(videoSources.id, sourceId) });
      if (!source) throw new Error("父视频任务不存在。");
      if (source.status !== "failed" || source.phase !== "processing") throw new Error("父视频只有 failed + processing 状态可以重试。");
      const file = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.videoSourceId, sourceId), orderBy: asc(taskFiles.createdAt) });
      if (!file) throw new Error("父视频没有原始任务文件。");
      // 已经完成分镜时只重放失败的 analyze_segment 作业；成功切片和分析结果保持不变。
      if (await this.pipeline.retryVideoSegments(file.id)) {
        return { status: "running" as const, phase: "processing" as const };
      }
      const pendingSlices = await this.database.db.query.assets.findMany({ where: and(eq(assets.videoSourceId, sourceId), eq(assets.status, "pending_review"), eq(assets.phase, "pending_review")) });
      if (pendingSlices.length) {
        await this.pipeline.enqueueVideoFinalizeIfReady(file.id, file.taskId, sourceId);
        return { status: "running" as const, phase: "processing" as const };
      }
      if (file.status !== "failed" || file.phase !== "processing" || !file.uploadObjectId) throw new Error("父视频不具备可恢复的 failed + processing 原始文件。");
      await this.database.db.update(taskFiles).set({ status: "queued", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: new Date() }).where(eq(taskFiles.id, file.id));
      await this.pipeline.processTaskFile(file.id, signal);
      return { status: "running" as const, phase: "processing" as const };
    }
    if (!fileId) throw new Error("重试目标为空。");
    const asset = await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) });
    if (!asset) {
      const original = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.fileId, fileId), orderBy: asc(taskFiles.createdAt) });
      if (!original || original.status !== "failed" || original.phase !== "processing" || !original.uploadObjectId) throw new Error("没有找到可恢复的 failed + processing 原始图片。");
      await this.database.db.update(taskFiles).set({ status: "queued", phase: "processing", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: new Date() }).where(eq(taskFiles.id, original.id));
      await this.pipeline.processTaskFile(original.id, signal);
      const refreshed = await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, original.id) });
      if (!refreshed) throw new Error("重试后任务文件不存在。");
      return { status: refreshed.status, phase: refreshed.phase };
    }
    if (asset.status !== "failed" || asset.phase !== "processing") throw new Error("素材只有 failed + processing 状态可以重试。");
    if (!asset.taskFileId) throw new Error("素材缺少可重放的任务文件。");
    await this.pipeline.processTaskFile(asset.taskFileId, signal);
    const refreshed = await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) });
    if (!refreshed) throw new Error("重试后素材不存在。");
    return { status: refreshed.status, phase: refreshed.phase };
  }

  async delete(payload: Record<string, unknown>) {
    const fileId = typeof payload.file_id === "string" ? payload.file_id : null;
    const videoSourceId = typeof payload.video_source_id === "string" ? payload.video_source_id : null;
    const requestedUserId = requestedDeletionUserId(payload.user_id);
    const asset = fileId
      ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) })
      : undefined;
    if (!asset || asset.phase !== "published") {
      return this.deleteFailedUpload(fileId, videoSourceId, requestedUserId);
    }
    if (requestedUserId) {
      if (asset.userId !== requestedUserId) throw new Error("只能删除本人素材。");
      // 软删除沿用既有语义：个人归属移除后成为公共素材，媒体对象不删除。
      await this.database.db.update(assets).set({ userId: null, updatedAt: new Date() }).where(eq(assets.id, asset.id));
      return { status: "done" as const, phase: "published" as const };
    }
    if (asset.userId !== null) throw new Error("硬删除个人素材必须携带对应 user_id。");
    const objects = [asset.mediaObjectId, asset.coverObjectId].filter((id): id is string => Boolean(id));
    const rows = await Promise.all(objects.map((id) => this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, id) })));
    await Promise.all(rows.filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => this.zos.delete(row.objectKey)));
    await this.database.db.transaction(async (tx) => {
      // 当前 delete 作业也使用 file_id；只移除派生 embed 作业，确保 worker
      // 仍能提交本次删除任务的终态并投递 callback。
      await tx.delete(jobs).where(and(eq(jobs.fileId, asset.id), eq(jobs.type, "embed")));
      await tx.delete(assets).where(eq(assets.id, asset.id));
      for (const id of objects) await tx.delete(mediaObjects).where(eq(mediaObjects.id, id));
      if (asset.videoSourceId) {
        const [source] = await tx.select().from(videoSources).where(eq(videoSources.id, asset.videoSourceId)).for("update").limit(1);
        const [remaining] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(eq(assets.videoSourceId, asset.videoSourceId));
        if (source && canDeleteOrphanVideoSource(source, Number(remaining?.count ?? 0))) await tx.delete(videoSources).where(eq(videoSources.id, source.id));
      }
    });
    const indexDeleted = await deleteDerivedIndexBestEffort(() => this.pipeline.chromaClient.delete(asset.id));
    if (!indexDeleted) {
      workerLog({
        operationId: randomUUID(),
        taskId: asset.taskId,
        fileId: asset.id,
        stage: "chroma_delete",
        status: "failed",
        error: new Error("Chroma 派生索引删除失败；MySQL 权限候选过滤会阻止残留索引被返回。"),
      });
    }
    return { status: "done" as const, phase: "expired" as const };
  }

  private async deleteFailedUpload(fileId: string | null, videoSourceId: string | null, requestedUserId: string | null) {
    if (Boolean(fileId) === Boolean(videoSourceId)) throw new Error("失败上传删除目标必须且只能提供一个。");
    const source = videoSourceId
      ? await this.database.db.query.videoSources.findFirst({ where: eq(videoSources.id, videoSourceId) })
      : undefined;
    const fileAsset = fileId
      ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) })
      : undefined;
    const originalFile = fileId
      ? await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.fileId, fileId), orderBy: asc(taskFiles.createdAt) })
      : await this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.videoSourceId, videoSourceId!), orderBy: asc(taskFiles.createdAt) });
    if (!originalFile) throw new Error("失败上传的原始任务文件不存在。");
    const originalTask = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, originalFile.taskId) });
    if (!originalTask) throw new Error("失败上传的原始任务不存在。");
    const state = fileAsset ?? source ?? originalFile;
    if (!isFailedProcessingTarget(state)) throw new Error("尚未入库的原始上传只有 failed + processing 状态可以删除。");
    const owner = fileAsset ? fileAsset.userId : source ? source.userId : originalTask.userId;
    if (!deletionScopeMatches(owner, requestedUserId)) throw new Error("只能删除同一用户范围内的失败上传。");

    const derivedAssets = videoSourceId
      ? await this.database.db.query.assets.findMany({ where: eq(assets.videoSourceId, videoSourceId) })
      : fileAsset ? [fileAsset] : [];
    if (derivedAssets.some((row) => row.phase === "published")) {
      throw new Error("父视频存在已入库切片，不能按失败原始上传整体删除。");
    }
    const objectIds = uniqueObjectIds([
      originalFile.uploadObjectId,
      source?.sourceObjectId,
      ...derivedAssets.flatMap((row) => [row.mediaObjectId, row.coverObjectId]),
    ]);
    const objectRows = objectIds.length
      ? await this.database.db.query.mediaObjects.findMany({ where: inArray(mediaObjects.id, objectIds) })
      : [];
    if (objectRows.some((row) => row.storageClass !== "temporary")) {
      throw new Error("失败上传清理拒绝删除非临时存储对象。");
    }
    const relatedFileCondition = fileId
      ? eq(taskFiles.fileId, fileId)
      : eq(taskFiles.videoSourceId, videoSourceId!);
    const relatedFiles = await this.database.db.query.taskFiles.findMany({ where: relatedFileCondition });
    const relatedTaskIds = [...new Set(relatedFiles.map((row) => row.taskId))];

    // ZOS 删除是幂等操作；先回收对象，随后事务清除所有引用。事务失败时重试删除仍然安全。
    await Promise.all(objectRows.map((row) => this.zos.delete(row.objectKey)));
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      const derivedIds = derivedAssets.map((row) => row.id);
      if (derivedIds.length) await tx.delete(assets).where(inArray(assets.id, derivedIds));
      const relatedJobCondition = fileId ? eq(jobs.fileId, fileId) : eq(jobs.videoSourceId, videoSourceId!);
      // 保留当前正在执行的 delete job，让 worker 能正常提交自己的终态；其余
      // validate/retry 等旧作业已经没有对象可处理，统一删除。
      await tx.delete(jobs).where(and(relatedJobCondition, ne(jobs.type, "delete")));
      await tx.update(taskFiles).set({
        uploadObjectId: null,
        status: "done",
        phase: "expired",
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        updatedAt: now,
      }).where(relatedFileCondition);
      if (source) {
        await tx.update(videoSources).set({
          sourceObjectId: null,
          status: "done",
          phase: "expired",
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          updatedAt: now,
        }).where(eq(videoSources.id, source.id));
      }
      if (objectIds.length) await tx.delete(mediaObjects).where(inArray(mediaObjects.id, objectIds));

      for (const relatedTaskId of relatedTaskIds) {
        const rows = await tx.select({
          status: taskFiles.status,
          phase: taskFiles.phase,
          count: sql<number>`count(*)`.mapWith(Number),
        }).from(taskFiles).where(eq(taskFiles.taskId, relatedTaskId)).groupBy(taskFiles.status, taskFiles.phase);
        const pending = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(assets)
          .where(and(eq(assets.taskId, relatedTaskId), eq(assets.phase, "pending_review")));
        const aggregate = aggregateUploadTask(rows, Number(pending[0]?.count ?? 0));
        const terminal = aggregate.status !== "running";
        await tx.update(tasks).set({
          status: aggregate.status,
          phase: aggregate.phase,
          totalFiles: aggregate.totalFiles,
          doneFiles: aggregate.doneFiles,
          failedFiles: aggregate.failedFiles,
          ...(aggregate.status !== "failed" ? { errorCode: null, errorMessage: null, errorDetails: null } : {}),
          finishedAt: terminal ? now : null,
          purgeAt: purgeAtForState(aggregate.status, aggregate.phase, now, this.config.TASK_HISTORY_RETENTION_HOURS),
          updatedAt: now,
        }).where(eq(tasks.id, relatedTaskId));
      }
    });
    await Promise.all(derivedAssets.map((row) => deleteDerivedIndexBestEffort(() => this.pipeline.chromaClient.delete(row.id))));
    return { status: "done" as const, phase: "expired" as const };
  }
}
