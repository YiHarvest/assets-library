import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeAll } from "@/server/storage/object-storage";
import {
  ScenePipelineError,
  type SceneSplitManifest,
} from "./types";

const segmentSchema = z.object({
  index: z.number().int().positive(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  durationSeconds: z.number().positive(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  filename: z.string().min(1),
  downloadUrl: z.string().min(1),
});

const manifestSchema = z.object({
  taskId: z.string().regex(/^[0-9a-f]{32}$/i),
  originalFilename: z.string().min(1),
  durationSeconds: z.number().positive(),
  sceneCount: z.number().int().positive(),
  segments: z.array(segmentSchema).min(1),
});

interface SceneServiceErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export interface SceneDetectClientOptions {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  fetchImplementation?: typeof fetch;
}

/** POST /split 的 202 响应：任务 ID 与初始状态。 */
const enqueueSchema = z.object({
  taskId: z.string().regex(/^[0-9a-f]{32}$/i),
  status: z.enum(["queued", "processing", "done", "failed", "cancelled"]),
});

/** GET /split/{taskId} 的状态响应：done 时附带切片清单。 */
const statusSchema = enqueueSchema.extend({
  originalFilename: z.string().min(1).nullish(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
    })
    .nullish(),
  durationSeconds: z.number().positive().nullish(),
  sceneCount: z.number().int().positive().nullish(),
  segments: z.array(segmentSchema).nullish(),
});

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("操作已取消。"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface DownloadedSceneSegment {
  absolutePath: string;
  sizeBytes: number;
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function responseError(response: Response) {
  let payload: SceneServiceErrorPayload | undefined;
  try {
    payload = (await response.json()) as SceneServiceErrorPayload;
  } catch {
    // 非 JSON 错误页不应覆盖稳定的本地错误格式。
  }
  const remoteMessage = payload?.error?.message;
  return new ScenePipelineError(
    "scene_detection_failed",
    typeof remoteMessage === "string"
      ? `分镜服务处理失败：${remoteMessage}`
      : `分镜服务处理失败（HTTP ${response.status}）。`,
    {
      httpStatus: response.status,
      remoteCode: payload?.error?.code,
      remoteDetails: payload?.error?.details,
    },
  );
}

function validateManifestRelationships(manifest: SceneSplitManifest) {
  if (
    manifest.sceneCount !== manifest.segments.length ||
    manifest.segments.some((segment, offset) => segment.index !== offset + 1)
  ) {
    throw new ScenePipelineError(
      "scene_manifest_invalid",
      "分镜服务返回的切片数量或序号不完整。",
      { taskId: manifest.taskId },
    );
  }

  for (const [offset, segment] of manifest.segments.entries()) {
    const previous = manifest.segments[offset - 1];
    const durationDifference = Math.abs(
      segment.endSeconds - segment.startSeconds - segment.durationSeconds,
    );
    if (
      segment.endSeconds <= segment.startSeconds ||
      segment.endFrame <= segment.startFrame ||
      durationDifference > 0.15 ||
      (previous && segment.startSeconds + 0.05 < previous.endSeconds)
    ) {
      throw new ScenePipelineError(
        "scene_manifest_invalid",
        `第 ${segment.index} 个切片的时间范围无效。`,
        { taskId: manifest.taskId, segmentIndex: segment.index },
      );
    }
  }
}

function parseManifest(payload: unknown, taskId?: string) {
  try {
    const manifest = manifestSchema.parse(payload);
    validateManifestRelationships(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof ScenePipelineError) throw error;
    throw new ScenePipelineError(
      "scene_manifest_invalid",
      "分镜服务返回了不完整的切片清单。",
      { taskId },
      { cause: error },
    );
  }
}

/**
 * scene-detect-service 的轻量 HTTP 客户端。
 *
 * 上传和下载均使用文件流，父视频和切片不会整体读入 Node.js 内存。
 */
export class SceneDetectClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly request: typeof fetch;

  constructor(options: SceneDetectClientOptions) {
    this.baseUrl = new URL(options.baseUrl.replace(/\/$/, "") + "/");
    this.timeoutMs = options.timeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.request = options.fetchImplementation ?? fetch;
  }

  async health(signal?: AbortSignal) {
    try {
      const response = await this.request(new URL("health", this.baseUrl), {
        signal: timeoutSignal(Math.min(this.timeoutMs, 5_000), signal),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async splitVideo(
    inputPath: string,
    originalFilename: string,
    signal?: AbortSignal,
  ): Promise<SceneSplitManifest> {
    const form = new FormData();
    const video = await fs.openAsBlob(inputPath, { type: "video/mp4" });
    // 父视频已在素材库侧正规化为 MP4；分镜服务会同时校验上传文件名后缀，
    // 因此即使用户原始文件叫 foo.avi，也必须以安全的 .mp4 名称传给服务。
    const originalBase = path.basename(originalFilename, path.extname(originalFilename));
    const serviceFilename = `${originalBase || "video"}.mp4`;
    form.set("file", video, serviceFilename);

    // 1. 提交任务：202 立即返回，分割在分镜服务的队列 worker 中异步执行
    let taskId: string | undefined;
    try {
      const response = await this.request(
        new URL("api/v1/videos/split", this.baseUrl),
        {
          method: "POST",
          body: form,
          signal: timeoutSignal(this.timeoutMs, signal),
        },
      );
      if (!response.ok) throw await responseError(response);
      const payload: unknown = await response.json();
      // 滚动部署期间兼容旧分镜服务：旧版 POST 同步返回 200 + manifest，
      // 新版返回 202 + taskId，随后由客户端轮询。
      if (response.status === 200) return parseManifest(payload);
      if (response.status !== 202) {
        throw new ScenePipelineError(
          "scene_detection_failed",
          `分镜服务返回了非预期状态码（HTTP ${response.status}）。`,
          { httpStatus: response.status },
        );
      }
      taskId = enqueueSchema.parse(payload).taskId;
    } catch (error) {
      if (error instanceof ScenePipelineError) throw error;
      throw new ScenePipelineError(
        "scene_service_unavailable",
        "无法连接分镜服务，或提交分割任务失败。",
        {},
        { cause: error },
      );
    }

    // 2. 轮询任务状态直到 done/failed。总预算需覆盖排队时间（worker 池有界，
    //    高峰时任务排队），timeoutMs 默认 10 分钟。
    const deadline = Date.now() + this.timeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ScenePipelineError(
            "scene_detection_failed",
            `分镜服务在 ${Math.round(this.timeoutMs / 1000)}s 内未完成处理。`,
            { taskId },
          );
        }

        let status: z.infer<typeof statusSchema>;
        try {
          const response = await this.request(
            new URL(`api/v1/videos/split/${taskId}`, this.baseUrl),
            { signal: timeoutSignal(Math.min(remaining, this.timeoutMs), signal) },
          );
          if (!response.ok) throw await responseError(response);
          status = statusSchema.parse(await response.json());
        } catch (error) {
          if (error instanceof ScenePipelineError) throw error;
          throw new ScenePipelineError(
            "scene_detection_failed",
            "轮询分镜任务状态失败。",
            { taskId },
            { cause: error },
          );
        }

        if (status.status === "done") {
          return parseManifest({
            taskId: status.taskId,
            originalFilename: status.originalFilename,
            durationSeconds: status.durationSeconds,
            sceneCount: status.sceneCount,
            segments: status.segments,
          }, taskId);
        }
        if (status.status === "failed") {
          throw new ScenePipelineError(
            "scene_detection_failed",
            `分镜服务处理失败：${status.error?.message ?? "未知错误"}`,
            { taskId, remoteCode: status.error?.code },
          );
        }
        if (status.status === "cancelled") {
          throw new ScenePipelineError(
            "scene_detection_failed",
            "分镜任务已被取消。",
            { taskId },
          );
        }

        // queued / processing：等待后继续轮询；外部取消会立刻中断等待。
        await sleep(Math.min(this.pollIntervalMs, remaining), signal);
      }
    } catch (error) {
      // 任务已经创建但未成功交付 manifest 时主动取消，避免服务端源视频和
      // 分片目录一直占用磁盘。清理使用独立超时，不复用可能已 abort 的信号。
      await this.deleteTask(taskId);
      throw error;
    }
  }

  /** 将一个切片流式下载到指定路径，并以实际字节数再次执行上限校验。 */
  async downloadSegment(
    manifest: Pick<SceneSplitManifest, "taskId">,
    segment: SceneSplitManifest["segments"][number],
    destinationPath: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<DownloadedSceneSegment> {
    const downloadUrl = new URL(segment.downloadUrl, this.baseUrl);
    const expectedPath = `/api/v1/videos/split/${manifest.taskId}/segments/${segment.index}`;
    if (
      downloadUrl.origin !== this.baseUrl.origin ||
      downloadUrl.pathname !== expectedPath
    ) {
      throw new ScenePipelineError(
        "scene_manifest_invalid",
        `第 ${segment.index} 个切片包含不安全的下载地址。`,
        { segmentIndex: segment.index },
      );
    }

    let response: Response;
    try {
      response = await this.request(downloadUrl, {
        signal: timeoutSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      throw new ScenePipelineError(
        "scene_segment_download_failed",
        `第 ${segment.index} 个切片下载失败。`,
        { segmentIndex: segment.index },
        { cause: error },
      );
    }
    if (!response.ok || !response.body) {
      throw new ScenePipelineError(
        "scene_segment_download_failed",
        `第 ${segment.index} 个切片下载失败（HTTP ${response.status}）。`,
        { segmentIndex: segment.index, httpStatus: response.status },
      );
    }

    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    const temporaryPath = `${destinationPath}.download`;
    const file = await fsPromises.open(temporaryPath, "wx");
    let receivedBytes = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel();
          throw new ScenePipelineError(
            "scene_segment_too_large",
            `第 ${segment.index} 个切片超过 ${Math.round(maximumBytes / 1024 / 1024)} MiB 限制。`,
            {
              segmentIndex: segment.index,
              actualBytes: receivedBytes,
              maximumBytes,
            },
          );
        }
        await writeAll(file, value);
      }
      if (receivedBytes === 0 || receivedBytes !== segment.sizeBytes) {
        throw new ScenePipelineError(
          "scene_segment_download_failed",
          `第 ${segment.index} 个切片下载不完整。`,
          {
            segmentIndex: segment.index,
            expectedBytes: segment.sizeBytes,
            actualBytes: receivedBytes,
          },
        );
      }
      await file.sync();
      await file.close();
      await fsPromises.rename(temporaryPath, destinationPath);
      return { absolutePath: destinationPath, sizeBytes: receivedBytes };
    } catch (error) {
      await file.close().catch(() => undefined);
      await fsPromises.rm(temporaryPath, { force: true });
      if (error instanceof ScenePipelineError) throw error;
      throw new ScenePipelineError(
        "scene_segment_download_failed",
        `第 ${segment.index} 个切片保存失败。`,
        { segmentIndex: segment.index },
        { cause: error },
      );
    }
  }

  /** 删除分镜服务中的源视频和所有切片；清理失败不会掩盖业务结果。 */
  async deleteTask(taskId: string, signal?: AbortSignal) {
    try {
      const response = await this.request(
        new URL(`api/v1/videos/split/${taskId}`, this.baseUrl),
        {
          method: "DELETE",
          signal: timeoutSignal(Math.min(this.timeoutMs, 10_000), signal),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
