import { isIP } from "node:net";
import { z } from "zod";
import { loadConfig } from "../config";

export const sceneSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  durationSeconds: z.number().positive().optional(),
  sizeBytes: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255).refine((value) => !value.includes("/") && !value.includes("\\") && value.toLowerCase().endsWith(".mp4")),
  downloadUrl: z.string().min(1),
}).refine((segment) => segment.endSeconds > segment.startSeconds, "切片时间范围无效");

const manifestSchema = z.object({
  taskId: z.string().min(1).optional(),
  originalFilename: z.string().optional(),
  durationSeconds: z.number().positive(),
  sceneCount: z.number().int().positive(),
  segments: z.array(sceneSegmentSchema).min(1).max(1000),
}).superRefine((manifest, context) => {
  if (manifest.sceneCount !== manifest.segments.length) context.addIssue({ code: "custom", path: ["sceneCount"], message: "sceneCount 与切片数量不一致" });
  const indexes = new Set<number>();
  let previousEnd = 0;
  for (const [position, segment] of manifest.segments.entries()) {
    if (indexes.has(segment.index)) context.addIssue({ code: "custom", path: ["segments", position, "index"], message: "切片序号重复" });
    indexes.add(segment.index);
    if (position > 0 && segment.startSeconds < previousEnd - 0.05) context.addIssue({ code: "custom", path: ["segments", position], message: "切片时间重叠或乱序" });
    previousEnd = segment.endSeconds;
  }
});

const enqueueSchema = z.object({
  taskId: z.string().regex(/^[0-9a-f]{32}$/i),
  status: z.enum(["queued", "processing", "done", "failed", "cancelled"]),
});

const statusSchema = enqueueSchema.extend({
  originalFilename: z.string().min(1).nullish(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }).nullish(),
  durationSeconds: z.number().positive().nullish(),
  sceneCount: z.number().int().positive().nullish(),
  segments: z.array(sceneSegmentSchema).nullish(),
});

export type SceneManifest = z.infer<typeof manifestSchema>;
export type SceneSegment = z.infer<typeof sceneSegmentSchema>;

function requestSignal(timeoutMs: number, externalSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeDownloadUrl(raw: string, base: URL) {
  const target = new URL(raw, base);
  if (target.protocol !== base.protocol || target.origin !== base.origin || target.username || target.password) throw new Error("分镜切片 URL 必须与已配置服务同源。");
  // 配置为 IP 时禁止服务响应换成另一个 IP；域名仍由同源约束保护。
  if (isIP(base.hostname) && target.hostname !== base.hostname) throw new Error("分镜切片 IP 与配置不一致。");
  return target;
}

export class SceneClient {
  private readonly config = loadConfig();
  private readonly base = new URL(this.config.SCENE_DETECT_BASE_URL);

  async split(bytes: Buffer, filename: string, externalSignal?: AbortSignal) {
    const deadline = Date.now() + this.config.SCENE_DETECT_TIMEOUT_MS;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
    let taskId: string | undefined;
    let completed = false;
    try {
      const response = await fetch(new URL("/api/v1/videos/split", this.base), {
        method: "POST", body: form, redirect: "manual",
        signal: requestSignal(this.config.SCENE_DETECT_TIMEOUT_MS, externalSignal),
      });
      if (!response.ok) throw new Error(`分镜服务提交任务失败：HTTP ${response.status}。`);
      taskId = enqueueSchema.parse(await response.json()).taskId;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`分镜任务 ${taskId} 等待超时。`);
        const statusResponse = await fetch(new URL(`/api/v1/videos/split/${taskId}`, this.base), {
          redirect: "manual",
          signal: requestSignal(Math.min(remaining, 30_000), externalSignal),
        });
        if (!statusResponse.ok) throw new Error(`查询分镜任务 ${taskId} 失败：HTTP ${statusResponse.status}。`);
        const state = statusSchema.parse(await statusResponse.json());
        if (state.status === "done") {
          const manifest = manifestSchema.parse({
            taskId: state.taskId,
            originalFilename: state.originalFilename ?? undefined,
            durationSeconds: state.durationSeconds,
            sceneCount: state.sceneCount,
            segments: state.segments,
          });
          completed = true;
          return manifest;
        }
        if (state.status === "failed") throw new Error(`分镜任务失败：${state.error?.message ?? "未知错误"}`);
        if (state.status === "cancelled") throw new Error("分镜任务已取消。");
        await delay(Math.min(this.config.SCENE_DETECT_POLL_INTERVAL_MS, remaining), externalSignal);
      }
    } finally {
      // 上游超时、退出或清单非法时取消远端任务，避免工作区长期遗留半成品。
      if (taskId && !completed) {
        await fetch(new URL(`/api/v1/videos/split/${taskId}`, this.base), {
          method: "DELETE", redirect: "manual", signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined);
      }
    }
  }

  async download(segment: SceneManifest["segments"][number], externalSignal?: AbortSignal) {
    if (segment.sizeBytes > this.config.SCENE_SEGMENT_MAX_BYTES) throw new Error(`切片 ${segment.index} 超过大小限制。`);
    const response = await fetch(safeDownloadUrl(segment.downloadUrl, this.base), { redirect: "manual", signal: requestSignal(this.config.SCENE_DETECT_TIMEOUT_MS, externalSignal) });
    if (!response.ok) throw new Error(`切片 ${segment.index} 下载失败：HTTP ${response.status}。`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength !== segment.sizeBytes) throw new Error(`切片 ${segment.index} Content-Length 不一致。`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== segment.sizeBytes || bytes.byteLength > this.config.SCENE_SEGMENT_MAX_BYTES) throw new Error(`切片 ${segment.index} 实际大小不一致。`);
    if (!bytes.subarray(4, 12).toString("ascii").includes("ftyp")) throw new Error(`切片 ${segment.index} 不是 MP4。`);
    return bytes;
  }
}
