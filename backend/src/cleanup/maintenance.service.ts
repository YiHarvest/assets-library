import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { loadConfig } from "../config";
import { DatabaseService } from "../database/database.service";
import { analysisResults, assets, jobs, mediaObjects, taskFiles, tasks, videoSources } from "../database/schema";
import { ZosService } from "../storage/zos.service";
import { ChromaClient } from "../search/chroma.client";
import { aggregateUploadTask, purgeAtForState, shouldReconcileUploadTask, videoSourceState } from "../worker/task-state";
import { shouldScheduleVideoFinalize } from "../worker/video-job-policy";

export class MaintenanceService {
  private readonly config = loadConfig();
  private readonly chroma = new ChromaClient();
  constructor(private readonly database: DatabaseService, private readonly zos: ZosService) {}

  async recoverStaleJobs() {
    const cutoff = new Date(Date.now() - this.config.WORKER_STALE_SECONDS * 1000);
    const staleJobs = await this.database.db.query.jobs.findMany({ where: and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)) });
    for (const job of staleJobs) {
      const anchor = job.fileId ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, job.fileId) }) : undefined;
      const leaseScope = or(
        ...(anchor?.taskFileId ? [eq(assets.taskFileId, anchor.taskFileId)] : []),
        ...(job.fileId ? [eq(assets.id, job.fileId)] : []),
        ...(job.videoSourceId ? [eq(assets.videoSourceId, job.videoSourceId)] : []),
        ...(job.taskId ? [eq(assets.taskId, job.taskId)] : []),
      );
      if (leaseScope) await this.database.db.update(assets).set({ status: "pending_review", phase: "pending_review", publicationLeaseToken: null, publicationLeaseAt: null, updatedAt: new Date() }).where(and(leaseScope, eq(assets.status, "running"), eq(assets.phase, "processing")));
      await this.database.db.update(jobs).set({ status: "queued", lockedAt: null, availableAt: new Date(), errorMessage: "worker 中断，作业自动恢复。", updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
    }
    const staleCompletes = await this.database.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.type, "upload"), eq(tasks.status, "running"), eq(tasks.phase, "uploading"), lt(tasks.updatedAt, cutoff))).limit(100);
    for (const task of staleCompletes) {
      const [uploading, validateJob] = await Promise.all([
        this.database.db.query.taskFiles.findFirst({ where: and(eq(taskFiles.taskId, task.id), eq(taskFiles.phase, "uploading")) }),
        this.database.db.query.jobs.findFirst({ where: and(eq(jobs.taskId, task.id), eq(jobs.type, "validate"), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))) }),
      ]);
      if (uploading && !validateJob) await this.database.db.update(tasks).set({ status: "queued", phase: "uploading", errorCode: null, errorMessage: null, errorDetails: null, updatedAt: new Date() }).where(and(eq(tasks.id, task.id), eq(tasks.status, "running"), eq(tasks.phase, "uploading")));
    }
  }

  /** 以 task_files 为唯一计数口径，避免视频切片数污染 total_files。 */
  async reconcileTasks() {
    const active = await this.database.db.select({ id: tasks.id, previousStatus: tasks.status, previousPhase: tasks.phase, finishedAt: tasks.finishedAt, purgeAt: tasks.purgeAt }).from(tasks).where(or(
      and(eq(tasks.type, "upload"),
      or(
        and(inArray(tasks.status, ["queued", "running"]), eq(tasks.phase, "processing")),
        and(eq(tasks.status, "pending_review"), eq(tasks.phase, "pending_review")),
      )),
      // failed retry/delete等变更任务也可能引用随后已删除的原始目标，需要对账。
      and(eq(tasks.status, "failed"), eq(tasks.phase, "processing")),
    ));
    for (const { id, previousStatus, previousPhase, finishedAt, purgeAt } of active) {
      if (!shouldReconcileUploadTask(previousStatus, previousPhase)) continue;
      // 历史版本可能先删除 assets，再遗漏回写原上传 task_file，留下无法预览、
      // 也无法 publish 的 pending_review 孤儿。存在临时源对象时降级为 failed，
      // 允许用户重试；对象已经不存在时直接置为 expired，从待入库列表移除。
      const pendingFiles = await this.database.db.query.taskFiles.findMany({
        where: and(eq(taskFiles.taskId, id), eq(taskFiles.phase, "pending_review")),
      });
      for (const file of pendingFiles) {
        const relationScope = or(
          eq(assets.taskFileId, file.id),
          ...(file.fileId ? [eq(assets.id, file.fileId)] : []),
          ...(file.videoSourceId ? [eq(assets.videoSourceId, file.videoSourceId)] : []),
        );
        const relatedAsset = await this.database.db.query.assets.findFirst({
          where: relationScope,
        });
        if (relatedAsset) continue;
        const uploadObject = file.uploadObjectId
          ? await this.database.db.query.mediaObjects.findFirst({
              where: eq(mediaObjects.id, file.uploadObjectId),
            })
          : undefined;
        const recoverable = uploadObject?.storageClass === "temporary";
        await this.database.db.update(taskFiles).set({
          status: recoverable ? "failed" : "done",
          phase: recoverable ? "processing" : "expired",
          errorCode: recoverable ? "asset_record_missing" : null,
          errorMessage: recoverable
            ? "处理结果记录缺失，可重试恢复。"
            : null,
          errorDetails: null,
          updatedAt: new Date(),
        }).where(eq(taskFiles.id, file.id));
      }
      const failedFiles = await this.database.db.query.taskFiles.findMany({
        where: and(eq(taskFiles.taskId, id), eq(taskFiles.status, "failed"), eq(taskFiles.phase, "processing")),
      });
      for (const file of failedFiles) {
        const [source, asset, uploadObject] = await Promise.all([
          file.videoSourceId
            ? this.database.db.query.videoSources.findFirst({ where: eq(videoSources.id, file.videoSourceId) })
            : undefined,
          file.fileId
            ? this.database.db.query.assets.findFirst({ where: eq(assets.id, file.fileId) })
            : undefined,
          file.uploadObjectId
            ? this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, file.uploadObjectId) })
            : undefined,
        ]);
        const deletedTarget = source?.phase === "expired"
          || asset?.phase === "expired"
          || (!source && !asset && !uploadObject);
        if (!deletedTarget) continue;
        await this.database.db.update(taskFiles).set({
          uploadObjectId: null,
          status: "done",
          phase: "expired",
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          updatedAt: new Date(),
        }).where(eq(taskFiles.id, file.id));
      }
      const rows = await this.database.db.select({ status: taskFiles.status, phase: taskFiles.phase, count: sql<number>`count(*)`.mapWith(Number) }).from(taskFiles).where(eq(taskFiles.taskId, id)).groupBy(taskFiles.status, taskFiles.phase);
      const pendingAssetRows = await this.database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(and(eq(assets.taskId, id), eq(assets.phase, "pending_review")));
      const pendingAssets = Number(pendingAssetRows[0]?.count ?? 0);
      const aggregate = aggregateUploadTask(rows, pendingAssets);
      const terminal = aggregate.status !== "running";
      const nextPurgeAt = purgeAtForState(aggregate.status, aggregate.phase, new Date(), this.config.TASK_HISTORY_RETENTION_HOURS);
      const enteredRetainedTerminal = Boolean(nextPurgeAt) && (!purgeAt || previousStatus !== aggregate.status);
      await this.database.db.update(tasks).set({ totalFiles: aggregate.totalFiles, doneFiles: aggregate.doneFiles, failedFiles: aggregate.failedFiles, status: aggregate.status, phase: aggregate.phase, ...(terminal && (!finishedAt || previousStatus !== aggregate.status) ? { finishedAt: new Date() } : {}), ...(enteredRetainedTerminal ? { purgeAt: nextPurgeAt } : {}), ...(aggregate.status === "pending_review" ? { purgeAt: null } : {}), updatedAt: new Date() }).where(eq(tasks.id, id));
    }
  }

  /**
   * analyze_segment 最后一次提交与 finalize 入队之间宕机时补齐汇总作业。只有全部
   * 切片作业进入终态才入队；已汇总过的批次仅在切片被重试后重新汇总。
   */
  async enqueueReadyVideoFinalizers() {
    const files = await this.database.db.query.taskFiles.findMany({
      where: and(eq(taskFiles.mediaType, "video"), isNotNull(taskFiles.videoSourceId), inArray(taskFiles.status, ["running", "failed"]), eq(taskFiles.phase, "processing")),
      limit: 100,
    });
    for (const file of files) {
      if (!file.videoSourceId) continue;
      const segmentJobs = await this.database.db.query.jobs.findMany({ where: and(eq(jobs.videoSourceId, file.videoSourceId), eq(jobs.type, "analyze_segment")) });
      const dedupeKey = `video-finalize:${file.id}`;
      const existing = await this.database.db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, dedupeKey) });
      if (!shouldScheduleVideoFinalize(segmentJobs, existing)) continue;
      const now = new Date();
      if (existing) {
        await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: now, updatedAt: now }).where(eq(jobs.id, existing.id));
      } else {
        await this.database.db.insert(jobs).ignore().values({ id: randomUUID(), taskId: file.taskId, videoSourceId: file.videoSourceId, type: "finalize", status: "queued", dedupeKey, payload: { task_file_id: file.id }, availableAt: now, createdAt: now, updatedAt: now });
      }
    }
  }

  async enqueueMissingEmbeddings() {
    if (!this.config.EMBEDDING_MODEL || !this.config.EMBEDDING_BASE_URL) return;
    const rows = await this.database.db.select({ assetId: analysisResults.assetId, taskId: assets.taskId }).from(analysisResults)
      .innerJoin(assets, eq(assets.id, analysisResults.assetId))
      .where(and(eq(assets.phase, "published"), or(isNull(analysisResults.indexedAt), ne(analysisResults.indexError, ""))))
      .limit(100);
    const now = new Date();
    for (const row of rows) {
      const dedupeKey = `asset-embed:${row.assetId}`;
      const existing = await this.database.db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, dedupeKey) });
      if (existing?.status === "queued" || existing?.status === "running") continue;
      if (existing) {
        await this.database.db.update(jobs).set({ status: "queued", attempts: 0, lockedAt: null, finishedAt: null, errorMessage: null, availableAt: now, updatedAt: now }).where(eq(jobs.id, existing.id));
      } else {
        await this.database.db.insert(jobs).ignore().values({ id: randomUUID(), taskId: row.taskId, fileId: row.assetId, type: "embed", status: "queued", attempts: 0, dedupeKey, availableAt: now, createdAt: now, updatedAt: now });
      }
    }
  }

  /** worker 在终态提交与 callback 入队之间宕机时，自动补齐回调作业。 */
  async reconcileCallbacks() {
    const terminal = await this.database.db.select({ id: tasks.id }).from(tasks).where(and(
      inArray(tasks.status, ["failed", "pending_review", "done"]),
      isNotNull(tasks.callbackUrl), isNull(tasks.callbackCompletedAt),
      lt(tasks.callbackAttempts, this.config.CALLBACK_MAX_ATTEMPTS),
    )).limit(100);
    const now = new Date();
    for (const task of terminal) {
      const existing = await this.database.db.query.jobs.findFirst({ where: and(eq(jobs.taskId, task.id), eq(jobs.type, "callback"), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))) });
      if (!existing) await this.database.db.insert(jobs).values({ id: randomUUID(), taskId: task.id, type: "callback", status: "queued", attempts: 0, availableAt: now, createdAt: now, updatedAt: now });
    }
  }

  async cleanupExpired() {
    const cutoff = new Date(Date.now() - this.config.TEMP_FILE_TTL_HOURS * 3600_000);
    const expiredObjects = await this.database.db.select().from(mediaObjects)
      .where(and(eq(mediaObjects.storageClass, "temporary"), lt(mediaObjects.createdAt, cutoff))).limit(500);
    const affectedTaskFiles = new Set<string>();
    const affectedVideoSources = new Set<string>();
    const affectedTasks = new Set<string>();
    for (const media of expiredObjects) {
      const [asset, file, source] = await Promise.all([
        this.database.db.query.assets.findFirst({ where: or(eq(assets.mediaObjectId, media.id), eq(assets.coverObjectId, media.id)) }),
        this.database.db.query.taskFiles.findFirst({ where: eq(taskFiles.uploadObjectId, media.id) }),
        this.database.db.query.videoSources.findFirst({ where: eq(videoSources.sourceObjectId, media.id) }),
      ]);
      const relatedTaskId = asset?.taskId ?? file?.taskId ?? source?.taskId;
      const freshLease = asset?.publicationLeaseToken && asset.publicationLeaseAt && asset.publicationLeaseAt >= new Date(Date.now() - this.config.WORKER_STALE_SECONDS * 1000);
      if (freshLease) continue;
      if (relatedTaskId || asset || source) {
        const scope = or(
          ...(relatedTaskId ? [eq(jobs.taskId, relatedTaskId)] : []),
          ...(asset ? [eq(jobs.fileId, asset.id)] : []),
          ...(asset?.videoSourceId ? [eq(jobs.videoSourceId, asset.videoSourceId)] : []),
          ...(source ? [eq(jobs.videoSourceId, source.id)] : []),
        );
        const activeJob = await this.database.db.query.jobs.findFirst({ where: and(
          scope, eq(jobs.status, "running"),
          isNotNull(jobs.lockedAt),
          sql`${jobs.lockedAt} >= ${new Date(Date.now() - this.config.WORKER_STALE_SECONDS * 1000)}`,
        ) });
        if (activeJob) continue;
      }
      const sourceAssets = source ? await this.database.db.query.assets.findMany({ where: eq(assets.videoSourceId, source.id) }) : [];
      const otherPendingForFile = file ? await this.database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(and(
        eq(assets.taskFileId, file.id), eq(assets.phase, "pending_review"),
        ...(asset ? [ne(assets.id, asset.id)] : []),
      )) : [];
      const keepFilePending = Number(otherPendingForFile[0]?.count ?? 0) > 0;
      const hasPublishedSourceSlices = sourceAssets.some((item) => item.phase === "published");
      const sourceState = videoSourceState(sourceAssets.map((item) => item.phase));
      try { await this.zos.delete(media.objectKey); } catch { continue; }
      const now = new Date();
      await this.database.db.transaction(async (tx) => {
        if (asset && asset.phase !== "published") {
          await tx.update(assets).set({ status: "done", phase: "expired", updatedAt: now }).where(and(eq(assets.id, asset.id), ne(assets.phase, "published")));
        }
        if (file) await tx.update(taskFiles).set({ uploadObjectId: null, ...(keepFilePending ? {} : { status: "done" as const, phase: hasPublishedSourceSlices ? "published" as const : "expired" as const, errorCode: null, errorMessage: null, errorDetails: null }), updatedAt: now }).where(eq(taskFiles.id, file.id));
        if (source) {
          await tx.update(videoSources).set({ sourceObjectId: null, ...sourceState, errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, source.id));
          if (sourceAssets.length === 0) await tx.delete(videoSources).where(eq(videoSources.id, source.id));
        }
        // 没有 asset 强引用时可立即清理对象元数据；asset 元数据保留至任务终态24h。
        if (!asset) await tx.delete(mediaObjects).where(eq(mediaObjects.id, media.id));
      });
      if (asset?.taskFileId) affectedTaskFiles.add(asset.taskFileId);
      if (asset?.videoSourceId) affectedVideoSources.add(asset.videoSourceId);
      if (asset?.taskId) affectedTasks.add(asset.taskId);
      if (file) { affectedTaskFiles.add(file.id); affectedTasks.add(file.taskId); if (file.videoSourceId) affectedVideoSources.add(file.videoSourceId); }
      if (source) { affectedVideoSources.add(source.id); if (source.taskId) affectedTasks.add(source.taskId); }
      if (asset && asset.phase !== "published") await this.chroma.delete(asset.id).catch(() => undefined);
    }
    const now = new Date();
    for (const taskFileId of affectedTaskFiles) {
      const grouped = await this.database.db.select({ phase: assets.phase, count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(eq(assets.taskFileId, taskFileId)).groupBy(assets.phase);
      const state = videoSourceState(grouped.flatMap((row) => Array.from({ length: row.count }, () => row.phase)));
      await this.database.db.update(taskFiles).set({ ...state, errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(taskFiles.id, taskFileId));
    }
    for (const sourceId of affectedVideoSources) {
      const grouped = await this.database.db.select({ phase: assets.phase, count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(eq(assets.videoSourceId, sourceId)).groupBy(assets.phase);
      const state = videoSourceState(grouped.flatMap((row) => Array.from({ length: row.count }, () => row.phase)));
      if (state.status === "done") await this.database.db.update(videoSources).set({ ...state, errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(videoSources.id, sourceId));
    }
    for (const taskId of affectedTasks) {
      const remaining = await this.database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(taskFiles).where(and(eq(taskFiles.taskId, taskId), inArray(taskFiles.status, ["queued", "running", "pending_review"])));
      const pendingAssets = await this.database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(and(eq(assets.taskId, taskId), eq(assets.phase, "pending_review")));
      if (Number(remaining[0]?.count ?? 0) > 0 || Number(pendingAssets[0]?.count ?? 0) > 0) continue;
      const rows = await this.database.db.select({ status: taskFiles.status, phase: taskFiles.phase, count: sql<number>`count(*)`.mapWith(Number) }).from(taskFiles).where(eq(taskFiles.taskId, taskId)).groupBy(taskFiles.status, taskFiles.phase);
      const aggregate = aggregateUploadTask(rows);
      await this.database.db.update(tasks).set({ status: aggregate.status, phase: aggregate.phase, totalFiles: aggregate.totalFiles, doneFiles: aggregate.doneFiles, failedFiles: aggregate.failedFiles, finishedAt: now, purgeAt: purgeAtForState(aggregate.status, aggregate.phase, now, this.config.TASK_HISTORY_RETENTION_HOURS), updatedAt: now }).where(eq(tasks.id, taskId));
    }
    const purgeCandidates = await this.database.db.select({ id: tasks.id }).from(tasks).where(and(lte(tasks.purgeAt, now), inArray(tasks.status, ["failed", "done"]))).limit(500);
    for (const candidate of purgeCandidates) {
      const pending = await this.database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(and(eq(assets.taskId, candidate.id), eq(assets.phase, "pending_review")));
      if (Number(pending[0]?.count ?? 0) > 0) {
        await this.database.db.update(tasks).set({ purgeAt: null, updatedAt: now }).where(eq(tasks.id, candidate.id));
      } else {
        const expiredAssets = await this.database.db.query.assets.findMany({ where: and(eq(assets.taskId, candidate.id), eq(assets.phase, "expired")) });
        const objectIds = expiredAssets.flatMap((asset) => [asset.mediaObjectId, ...(asset.coverObjectId ? [asset.coverObjectId] : [])]);
        await this.database.db.transaction(async (tx) => {
          if (expiredAssets.length) await tx.delete(assets).where(inArray(assets.id, expiredAssets.map((asset) => asset.id)));
          await tx.delete(videoSources).where(and(eq(videoSources.taskId, candidate.id), eq(videoSources.phase, "expired")));
          await tx.delete(tasks).where(eq(tasks.id, candidate.id));
          if (objectIds.length) await tx.delete(mediaObjects).where(inArray(mediaObjects.id, objectIds));
        });
      }
    }
  }
}
