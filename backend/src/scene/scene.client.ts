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

export type SceneManifest = z.infer<typeof manifestSchema>;
export type SceneSegment = z.infer<typeof sceneSegmentSchema>;

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
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
    const response = await fetch(new URL("/api/v1/videos/split", this.base), {
      method: "POST", body: form, redirect: "manual", signal: externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(this.config.SCENE_DETECT_TIMEOUT_MS)]) : AbortSignal.timeout(this.config.SCENE_DETECT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`分镜服务返回 HTTP ${response.status}。`);
    return manifestSchema.parse(await response.json());
  }

  async download(segment: SceneManifest["segments"][number], externalSignal?: AbortSignal) {
    if (segment.sizeBytes > this.config.SCENE_SEGMENT_MAX_BYTES) throw new Error(`切片 ${segment.index} 超过大小限制。`);
    const response = await fetch(safeDownloadUrl(segment.downloadUrl, this.base), { redirect: "manual", signal: externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(this.config.SCENE_DETECT_TIMEOUT_MS)]) : AbortSignal.timeout(this.config.SCENE_DETECT_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`切片 ${segment.index} 下载失败：HTTP ${response.status}。`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength !== segment.sizeBytes) throw new Error(`切片 ${segment.index} Content-Length 不一致。`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== segment.sizeBytes || bytes.byteLength > this.config.SCENE_SEGMENT_MAX_BYTES) throw new Error(`切片 ${segment.index} 实际大小不一致。`);
    if (!bytes.subarray(4, 12).toString("ascii").includes("ftyp")) throw new Error(`切片 ${segment.index} 不是 MP4。`);
    return bytes;
  }
}
