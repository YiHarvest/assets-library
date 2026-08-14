import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { CallbackService, isRetryableCallbackError } from "./callbacks/callback.service";
import { MaintenanceService } from "./cleanup/maintenance.service";
import { loadConfig } from "./config";
import { DatabaseService } from "./database/database.service";
import { assets, jobs, taskFiles, tasks, videoSources } from "./database/schema";
import { ZosService } from "./storage/zos.service";
import { startWorkerHeartbeat } from "./worker-heartbeat";
import { workerLog } from "./worker/logger";
import { MediaPipelineService } from "./worker/media-pipeline.service";
import { MutationService } from "./worker/mutation.service";
import { aggregateUploadTask, purgeAtForState } from "./worker/task-state";
import { isMaintenanceWorker } from "./worker/worker-role";

type Job = typeof jobs.$inferSelect;
type TaskOutcome = { status: "queued" | "running" | "failed" | "pending_review" | "done"; phase: "uploading" | "processing" | "pending_review" | "published" | "expired" };
const config = loadConfig();
const runsMaintenance = isMaintenanceWorker(config.WORKER_INDEX);
const database = new DatabaseService();
const zos = new ZosService();
const pipeline = new MediaPipelineService(database, zos);
const mutation = new MutationService(database, zos, pipeline);
const callbacks = new CallbackService(database);
const maintenance = new MaintenanceService(database, zos);
let stopping = false;
let activeJob: string | null = null;
const shutdownController = new AbortController();
let shutdownDeadline: NodeJS.Timeout | undefined;

function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function claim(): Promise<Job | undefined> {
  return database.db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.availableAt, new Date())))
      .orderBy(jobs.availableAt, jobs.createdAt).limit(1).for("update", { skipLocked: true });
    if (!candidate) return undefined;
    const now = new Date();
    const result = await tx.update(jobs).set({ status: "running", attempts: candidate.attempts + 1, lockedAt: now, errorMessage: null, updatedAt: now })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")));
    if (result[0].affectedRows !== 1) return undefined;
    return { ...candidate, status: "running" as const, attempts: candidate.attempts + 1, lockedAt: now, updatedAt: now };
  });
}

async function processJob(job: Job, signal: AbortSignal): Promise<TaskOutcome | undefined> {
  const payload = job.payload ?? {};
  if (job.type === "validate") {
    const taskFileId = String(payload.task_file_id ?? "");
    if (!taskFileId) throw new Error("validate 作业缺少 task_file_id。");
    await pipeline.processTaskFile(taskFileId, signal);
  } else if (job.type === "analyze_segment") {
    const taskFileId = String(payload.task_file_id ?? "");
    if (!taskFileId || !job.fileId || !job.videoSourceId) throw new Error("analyze_segment 作业缺少切片标识。");
    await pipeline.processVideoSegment(taskFileId, job.fileId, payload.segment, signal);
  } else if (job.type === "finalize") {
    const taskFileId = String(payload.task_file_id ?? "");
    if (!taskFileId) throw new Error("finalize 作业缺少 task_file_id。");
    await pipeline.finalizeVideo(taskFileId, signal);
  } else if (job.type === "publish") return mutation.publish(payload, signal);
  else if (job.type === "update") return mutation.update(payload);
  else if (job.type === "retry") return mutation.retry(payload, signal);
  else if (job.type === "delete") return mutation.delete(payload);
  else if (job.type === "embed") {
    if (!job.fileId) throw new Error("embed 作业缺少 file_id。");
    await pipeline.index(job.fileId);
  } else if (job.type === "callback") {
    if (!job.taskId) throw new Error("callback 作业缺少 task_id。");
    await callbacks.deliver(job.taskId, job.attempts, signal);
  } else if (job.type === "cleanup") await maintenance.cleanupExpired();
  else throw new Error(`不支持的作业类型：${job.type}`);
}

async function complete(job: Job, outcome?: TaskOutcome) {
  const now = new Date();
  await database.db.update(jobs).set({ status: "done", lockedAt: null, errorMessage: null, finishedAt: now, updatedAt: now }).where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
  if (!job.taskId || job.type === "callback" || job.type === "embed" || job.type === "cleanup") return;
  if (job.type === "validate") {
    await refreshUploadTask(job.taskId);
  } else if (job.type === "analyze_segment") {
    const taskFileId = String(job.payload?.task_file_id ?? "");
    if (taskFileId && job.videoSourceId) await pipeline.enqueueVideoFinalizeIfReady(taskFileId, job.taskId, job.videoSourceId);
    await refreshUploadTask(job.taskId);
  } else if (job.type === "finalize") {
    const taskFileId = String(job.payload?.task_file_id ?? "");
    const file = taskFileId ? await database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) }) : undefined;
    const related = file?.videoSourceId
      ? await database.db.query.taskFiles.findMany({ where: eq(taskFiles.videoSourceId, file.videoSourceId) })
      : [];
    for (const taskId of new Set([job.taskId, ...related.map((row) => row.taskId)])) {
      await refreshUploadTask(taskId);
      if (taskId !== job.taskId) await enqueueTerminalCallback(taskId);
    }
  } else {
    if (!outcome) throw new Error(`作业 ${job.type} 缺少终态结果。`);
    const mutationFile = await database.db.query.taskFiles.findFirst({ where: eq(taskFiles.taskId, job.taskId) });
    const refreshedAsset = job.fileId ? await database.db.query.assets.findFirst({ where: eq(assets.id, job.fileId) }) : undefined;
    if (mutationFile) await database.db.update(taskFiles).set({ status: outcome.status, phase: outcome.phase, ...(refreshedAsset ? { fileName: refreshedAsset.fileName, sizeBytes: refreshedAsset.sizeBytes } : {}), errorCode: null, errorMessage: null, errorDetails: null, updatedAt: now }).where(eq(taskFiles.id, mutationFile.id));
    const terminal = outcome.status === "failed" || outcome.status === "pending_review" || outcome.status === "done";
    const retained = outcome.status === "done" && (outcome.phase === "published" || outcome.phase === "expired");
    await database.db.update(tasks).set({ status: outcome.status, phase: outcome.phase, doneFiles: outcome.status === "done" || outcome.status === "pending_review" ? 1 : 0, failedFiles: outcome.status === "failed" ? 1 : 0, finishedAt: terminal ? now : null, purgeAt: retained ? new Date(now.getTime() + config.TASK_HISTORY_RETENTION_HOURS * 3600_000) : null, updatedAt: now }).where(eq(tasks.id, job.taskId));
  }
  await enqueueTerminalCallback(job.taskId);
}

async function fail(job: Job, error: unknown) {
  const now = new Date(); const message = error instanceof Error ? error.message.slice(0, 4000) : "作业失败。";
  if (job.type === "callback" && job.taskId && job.attempts < config.CALLBACK_MAX_ATTEMPTS && isRetryableCallbackError(error)) {
    const next = await callbacks.scheduleRetry(job.taskId, job.attempts);
    await database.db.update(jobs).set({ status: "queued", lockedAt: null, availableAt: next, errorMessage: message, updatedAt: now }).where(eq(jobs.id, job.id));
    workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: job.type, status: "retrying", attempt: job.attempts, error });
    return;
  }
  await database.db.update(jobs).set({ status: "failed", lockedAt: null, errorMessage: message, finishedAt: now, updatedAt: now }).where(eq(jobs.id, job.id));
  if (job.type === "callback" && job.taskId) {
    // schema 没有额外 stopped 字段；达到上限值作为“不再调度”的持久终态哨兵。
    await database.db.update(tasks).set({ callbackAttempts: config.CALLBACK_MAX_ATTEMPTS, nextCallbackAt: null, updatedAt: now }).where(eq(tasks.id, job.taskId));
  }
  if (!job.taskId || job.type === "callback" || job.type === "embed" || job.type === "cleanup") return;
  if (job.type === "validate") {
    const taskFileId = String(job.payload?.task_file_id ?? "");
    if (taskFileId) {
      const file = await database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
      await database.db.update(taskFiles).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(eq(taskFiles.id, taskFileId));
      if (file?.videoSourceId) await database.db.update(videoSources).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
    }
    await refreshUploadTask(job.taskId);
  } else if (job.type === "analyze_segment") {
    const taskFileId = String(job.payload?.task_file_id ?? "");
    if (taskFileId && job.videoSourceId) await pipeline.enqueueVideoFinalizeIfReady(taskFileId, job.taskId, job.videoSourceId);
    await refreshUploadTask(job.taskId);
  } else if (job.type === "finalize") {
    const taskFileId = String(job.payload?.task_file_id ?? "");
    if (taskFileId) {
      const file = await database.db.query.taskFiles.findFirst({ where: eq(taskFiles.id, taskFileId) });
      if (file?.videoSourceId) {
        await database.db.update(taskFiles).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(and(eq(taskFiles.videoSourceId, file.videoSourceId), inArray(taskFiles.status, ["queued", "running", "failed"])));
        await database.db.update(videoSources).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
        const related = await database.db.query.taskFiles.findMany({ where: eq(taskFiles.videoSourceId, file.videoSourceId) });
        for (const taskId of new Set(related.map((row) => row.taskId))) {
          await refreshUploadTask(taskId);
          if (taskId !== job.taskId) await enqueueTerminalCallback(taskId);
        }
      } else {
        await database.db.update(taskFiles).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(eq(taskFiles.id, taskFileId));
      }
    }
    await refreshUploadTask(job.taskId);
  } else {
    await database.db.update(taskFiles).set({ status: "failed", phase: "processing", errorCode: "processing_failed", errorMessage: message, updatedAt: now }).where(eq(taskFiles.taskId, job.taskId));
    await database.db.update(tasks).set({ status: "failed", phase: "processing", failedFiles: 1, errorCode: "processing_failed", errorMessage: message, finishedAt: now, purgeAt: new Date(now.getTime() + config.TASK_HISTORY_RETENTION_HOURS * 3600_000), updatedAt: now }).where(eq(tasks.id, job.taskId));
  }
  await enqueueTerminalCallback(job.taskId);
}

async function requeueInterrupted(job: Job) {
  await releasePublicationLeasesForJob(job);
  await database.db.update(jobs).set({ status: "queued", lockedAt: null, availableAt: new Date(), errorMessage: "worker 优雅退出，作业等待恢复。", updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
}

async function releasePublicationLeasesForJob(job: Job) {
  const anchor = job.fileId ? await database.db.query.assets.findFirst({ where: eq(assets.id, job.fileId) }) : undefined;
  const scope = or(
    ...(anchor?.taskFileId ? [eq(assets.taskFileId, anchor.taskFileId)] : []),
    ...(job.fileId ? [eq(assets.id, job.fileId)] : []),
    ...(job.videoSourceId ? [eq(assets.videoSourceId, job.videoSourceId)] : []),
    ...(job.taskId ? [eq(assets.taskId, job.taskId)] : []),
  );
  if (scope) await database.db.update(assets).set({ status: "pending_review", phase: "pending_review", publicationLeaseToken: null, publicationLeaseAt: null, updatedAt: new Date() }).where(and(scope, eq(assets.status, "running"), eq(assets.phase, "processing")));
}

async function enqueueTerminalCallback(taskId: string) {
  const task = await database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (task && ["failed", "pending_review", "done"].includes(task.status) && task.finishedAt) await callbacks.enqueue(taskId);
}

async function refreshUploadTask(taskId: string) {
  const rows = await database.db.select({ status: taskFiles.status, phase: taskFiles.phase, count: sql<number>`count(*)`.mapWith(Number) }).from(taskFiles).where(eq(taskFiles.taskId, taskId)).groupBy(taskFiles.status, taskFiles.phase);
  const pendingRows = await database.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(assets).where(and(eq(assets.taskId, taskId), eq(assets.phase, "pending_review")));
  const aggregate = aggregateUploadTask(rows, Number(pendingRows[0]?.count ?? 0));
  const now = new Date(); const terminal = aggregate.status !== "running";
  await database.db.update(tasks).set({ totalFiles: aggregate.totalFiles, doneFiles: aggregate.doneFiles, failedFiles: aggregate.failedFiles, status: aggregate.status, phase: aggregate.phase, ...(terminal ? { finishedAt: now, purgeAt: purgeAtForState(aggregate.status, aggregate.phase, now, config.TASK_HISTORY_RETENTION_HOURS) } : {}), updatedAt: now }).where(eq(tasks.id, taskId));
}

async function maintenanceLoop() {
  let lastCleanup = 0;
  while (!stopping) {
    const operationId = randomUUID(); const startedAt = Date.now();
    try {
      await maintenance.recoverStaleJobs();
      await maintenance.reconcileTasks();
      await maintenance.enqueueReadyVideoFinalizers();
      await maintenance.reconcileCallbacks();
      await maintenance.enqueueMissingEmbeddings();
      if (Date.now() - lastCleanup >= config.CLEANUP_INTERVAL_SECONDS * 1000) { await maintenance.cleanupExpired(); lastCleanup = Date.now(); }
      workerLog({ operationId, stage: "maintenance", status: "done", startedAt });
    } catch (error) { workerLog({ operationId, stage: "maintenance", status: "failed", startedAt, error }); }
    await delay(config.WORKER_MAINTENANCE_SECONDS * 1000, shutdownController.signal);
  }
}

async function main() {
  const stopHeartbeat = await startWorkerHeartbeat();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shutdownController.abort(new Error("worker 正在退出。"));
    shutdownDeadline = setTimeout(() => {
      void (async () => {
        if (activeJob) {
          const interrupted = await database.db.query.jobs.findFirst({ where: eq(jobs.id, activeJob) }).catch(() => undefined);
          await database.db.update(jobs).set({ status: "queued", lockedAt: null, availableAt: new Date(), errorMessage: "worker 退出超时，作业等待恢复。", updatedAt: new Date() }).where(and(eq(jobs.id, activeJob), eq(jobs.status, "running"))).catch(() => undefined);
          if (interrupted) await releasePublicationLeasesForJob(interrupted).catch(() => undefined);
        }
        workerLog({ operationId: activeJob ?? randomUUID(), stage: "shutdown_timeout", status: "failed", error: new Error("worker 优雅退出超时。") });
        process.exit(1);
      })();
    }, config.WORKER_SHUTDOWN_TIMEOUT_SECONDS * 1000);
    shutdownDeadline.unref();
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  if (runsMaintenance) await maintenance.recoverStaleJobs();
  // 只有 worker-1 负责恢复、清理、callback/embedding 对账。所有 worker 都可
  // 消费队列；维护者单一化可避免多个进程同时执行“先查后插”而重复入队。
  const maintenancePromise = runsMaintenance ? maintenanceLoop() : Promise.resolve();
  try {
    while (!stopping) {
      const job = await claim();
      if (!job) { await delay(config.WORKER_POLL_MS, shutdownController.signal); continue; }
      activeJob = job.id; const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        void database.db.update(jobs).set({ lockedAt: new Date(), updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, "running"))).catch((error) => {
          workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: "job_heartbeat", status: "failed", error });
        });
      }, Math.max(10_000, Math.floor(config.WORKER_STALE_SECONDS * 1000 / 3)));
      heartbeat.unref();
      workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: job.type, status: "started", attempt: job.attempts });
      try {
        const outcome = await processJob(job, shutdownController.signal); await complete(job, outcome);
        workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: job.type, status: "done", startedAt, attempt: job.attempts, progress: 100 });
      } catch (error) {
        if (stopping) {
          await requeueInterrupted(job);
          workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: job.type, status: "retrying", startedAt, attempt: job.attempts, error });
        } else {
          await fail(job, error);
          workerLog({ operationId: job.id, taskId: job.taskId, fileId: job.fileId, stage: job.type, status: "failed", startedAt, attempt: job.attempts, error });
        }
      } finally { clearInterval(heartbeat); activeJob = null; }
    }
  } finally {
    if (shutdownDeadline) clearTimeout(shutdownDeadline);
    await maintenancePromise;
    await stopHeartbeat();
    await database.onModuleDestroy();
    workerLog({ operationId: activeJob ?? randomUUID(), stage: "shutdown", status: "done" });
  }
}

void main().catch((error) => { workerLog({ operationId: randomUUID(), stage: "startup", status: "failed", error }); process.exitCode = 1; });
