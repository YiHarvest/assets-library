import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { and, asc, eq, or } from "drizzle-orm";
import { loadConfig } from "../config";
import { DatabaseService } from "../database/database.service";
import { assets, assetTags, jobs, mediaObjects, tags, taskFiles, tasks } from "../database/schema";

export function isPrivateCallbackAddress(address: string) {
  const mappedIpv4 = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateCallbackAddress(mappedIpv4);
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const value = address.toLowerCase();
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff");
}

async function lookupBeforeDeadline(hostname: string, deadlineAt: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("回调被取消。");
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new CallbackDeliveryError("回调 DNS 解析超过绝对60秒截止时间。", true, 408);
  return new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(); };
    const timer = setTimeout(() => finish(() => reject(new CallbackDeliveryError("回调 DNS 解析超过绝对60秒截止时间。", true, 408))), remaining);
    const abort = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("回调被取消。")));
    signal?.addEventListener("abort", abort, { once: true });
    void lookup(hostname, { all: true, verbatim: true }).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

async function pinnedCallbackTarget(raw: string, deadlineAt: number, signal?: AbortSignal) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new CallbackDeliveryError("callback_url 无效。", false);
  const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : await lookupBeforeDeadline(url.hostname, deadlineAt, signal);
  if (!addresses.length || addresses.some(({ address }) => isPrivateCallbackAddress(address))) throw new CallbackDeliveryError("callback_url 不允许访问内网地址。", false);
  return { url, pinned: addresses[0]! };
}

export function isRetryableCallbackStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export function callbackRetryDelayMs(failedAttempt: number) { return retryDelays[failedAttempt - 1]; }

export class CallbackDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); this.name = "CallbackDeliveryError"; }
}
export function isRetryableCallbackError(error: unknown) { return !(error instanceof CallbackDeliveryError) || error.retryable; }

export function callbackRequestHeaders(body: string, taskId: string) {
  return { "content-type": "application/json", "content-length": Buffer.byteLength(body), "X-Task-ID": taskId };
}

async function postPinned(rawUrl: string, body: string, taskId: string, timeoutMs: number, signal?: AbortSignal) {
  const deadlineAt = Date.now() + timeoutMs;
  const { url, pinned } = await pinnedCallbackTarget(rawUrl, deadlineAt, signal);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new CallbackDeliveryError("回调请求超过绝对60秒截止时间。", true, 408);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(deadline); callback(); };
    const request = transport.request(url, {
      method: "POST",
      headers: callbackRequestHeaders(body, taskId),
      // socket 使用本次已验证的固定 IP；TLS 仍按原 hostname 验证证书。
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family as 4 | 6),
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      // 回调成功与否只依赖响应码，不读取第三方无限/慢速响应体。
      response.destroy();
      finish(() => resolve(status));
    });
    const deadline = setTimeout(() => request.destroy(new CallbackDeliveryError("回调请求超过绝对60秒截止时间。", true, 408)), remaining);
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error("回调被取消。"));
    signal?.addEventListener("abort", abort, { once: true });
    request.once("close", () => {
      signal?.removeEventListener("abort", abort);
      if (!settled) finish(() => reject(new Error("回调连接在响应前关闭。")));
    });
    request.once("error", (error) => finish(() => reject(error)));
    request.end(body);
  });
}

function taskError(row: { errorCode: string | null; errorMessage: string | null; errorDetails: unknown }) {
  return row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? "任务失败。", ...(row.errorDetails ? { details: row.errorDetails } : {}) } : undefined;
}

export function buildCallbackTaskDto(task: {
  id: string; type: string; status: string; phase: string; totalFiles: number; doneFiles: number; failedFiles: number;
  errorCode: string | null; errorMessage: string | null; errorDetails: unknown; createdAt: Date; finishedAt: Date | null;
}, files: unknown[]) {
  const error = taskError(task);
  return { task_id: task.id, task_type: task.type, status: task.status, phase: task.phase, total_files: task.totalFiles, done_files: task.doneFiles, failed_files: task.failedFiles, files, ...(error ? { error } : {}), created_at: task.createdAt.toISOString(), ...(task.finishedAt ? { finished_at: task.finishedAt.toISOString() } : {}) };
}

export class CallbackService {
  private readonly config = loadConfig();
  constructor(private readonly database: DatabaseService) {}

  async enqueue(taskId: string) {
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task?.callbackUrl || task.callbackCompletedAt) return;
    const existing = await this.database.db.query.jobs.findFirst({ where: and(eq(jobs.taskId, taskId), eq(jobs.type, "callback"), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))) });
    if (existing) return;
    const now = new Date();
    await this.database.db.insert(jobs).values({ id: randomUUID(), taskId, type: "callback", status: "queued", attempts: 0, availableAt: now, createdAt: now, updatedAt: now });
  }

  /** 独立 presenter 与单任务查询 DTO 使用同一字段结构；未产生字段省略。 */
  private async taskDto(taskId: string) {
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) throw new CallbackDeliveryError("回调任务不存在。", false);
    const files = await this.database.db.query.taskFiles.findMany({ where: eq(taskFiles.taskId, task.id), orderBy: asc(taskFiles.ordinal) });
    const mapped = await Promise.all(files.map(async (file) => {
      const object = file.uploadObjectId ? await this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, file.uploadObjectId) }) : undefined;
      const slices = file.videoSourceId ? await this.database.db.query.assets.findMany({ where: eq(assets.videoSourceId, file.videoSourceId), orderBy: asc(assets.segmentStartMs) }) : [];
      const produced = file.fileId ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, file.fileId) }) : undefined;
      const producedSummary = produced ? await this.assetSummary(produced) : undefined;
      const fileError = taskError(file);
      return {
        ...(file.fileId ? { file_id: file.fileId } : {}), ...(file.videoSourceId ? { video_source_id: file.videoSourceId } : {}),
        file_name: file.fileName, media_type: file.mediaType, status: file.status, phase: file.phase,
        ...(object?.sizeBytes ? { size_bytes: object.sizeBytes } : {}),
        ...(producedSummary ? { media_url: producedSummary.media_url, cover_url: producedSummary.cover_url, description: producedSummary.description, tags: producedSummary.tags } : {}),
        ...(slices.length ? { slices: await Promise.all(slices.map(async (slice) => {
          const [media, cover, tagRows] = await Promise.all([
            this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, slice.mediaObjectId) }),
            slice.coverObjectId ? this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, slice.coverObjectId) }) : undefined,
            this.database.db.select({ value: tags.value }).from(assetTags).innerJoin(tags, eq(tags.id, assetTags.tagId)).where(eq(assetTags.assetId, slice.id)),
          ]);
          if (!media) throw new CallbackDeliveryError(`切片 ${slice.id} 缺少媒体对象。`, false);
          const error = taskError(slice);
          return { file_id: slice.id, file_name: slice.fileName, video_source_id: slice.videoSourceId!, media_type: "video" as const, status: slice.status, phase: slice.phase, description: slice.description, tags: tagRows.map((row) => row.value), size_bytes: slice.sizeBytes, media_url: media.publicUrl, cover_url: cover?.publicUrl ?? media.publicUrl, ...(error ? { error } : {}) };
        })) } : {}),
        ...(fileError ? { error: fileError } : {}),
      };
    }));
    return buildCallbackTaskDto(task, mapped);
  }

  private async assetSummary(asset: typeof assets.$inferSelect) {
    const [media, cover, tagRows] = await Promise.all([
      this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, asset.mediaObjectId) }),
      asset.coverObjectId ? this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, asset.coverObjectId) }) : undefined,
      this.database.db.select({ value: tags.value }).from(assetTags).innerJoin(tags, eq(tags.id, assetTags.tagId)).where(eq(assetTags.assetId, asset.id)),
    ]);
    if (!media) throw new CallbackDeliveryError(`素材 ${asset.id} 缺少媒体对象。`, false);
    return { media_url: media.publicUrl, cover_url: cover?.publicUrl ?? media.publicUrl, description: asset.description, tags: tagRows.map((row) => row.value) };
  }

  async deliver(taskId: string, attempt: number, signal?: AbortSignal) {
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task?.callbackUrl) return { completed: true };
    const status = await postPinned(task.callbackUrl, JSON.stringify(await this.taskDto(task.id)), task.id, this.config.CALLBACK_TIMEOUT_MS, signal);
    if (status < 200 || status >= 300) throw new CallbackDeliveryError(`回调返回 HTTP ${status}。`, isRetryableCallbackStatus(status), status);
    await this.database.db.update(tasks).set({ callbackAttempts: attempt, callbackCompletedAt: new Date(), nextCallbackAt: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return { completed: true };
  }

  async scheduleRetry(taskId: string, attempt: number) {
    const delay = callbackRetryDelayMs(attempt);
    if (delay === undefined) throw new CallbackDeliveryError("回调已达到最大尝试次数。", false);
    const next = new Date(Date.now() + delay);
    await this.database.db.update(tasks).set({ callbackAttempts: attempt, nextCallbackAt: next, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return next;
  }
}
