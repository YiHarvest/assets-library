import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/server/errors";
import { runMediaCommand } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";

const pending = new Map<string, Promise<string | null>>();
// 每个 Web 进程最多同时准备两个片段，避免下游批量下载时挤占全部转码资源。
const lanes = [Promise.resolve(), Promise.resolve()];

/** 按原对象版本和目标时长缓存；复用 staging 清理，缓存过期后可重新生成。 */
export async function prepareVideoClip(
  sourceVersion: string,
  durationMs: number,
  downloadSource: (destination: string) => Promise<unknown>,
) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new AppError("invalid_request", "裁剪时长必须是正整数毫秒。", 400);
  }
  const key = createHash("sha256").update(`${sourceVersion}:${durationMs}`).digest("hex");
  const directory = resolveMediaPath(path.join(".staging", `recall-${key}`));
  const output = path.join(directory, "clip.mp4");
  if (await fs.stat(output).then(stat => stat.size > 0, () => false)) {
    const now = new Date();
    await fs.utimes(directory, now, now);
    return output;
  }
  const existing = pending.get(output);
  if (existing) return existing;
  const operation = lanes.shift()!.then(createClip);
  lanes.push(operation.then(() => undefined, () => undefined));
  pending.set(output, operation);
  try {
    return await operation;
  } finally {
    pending.delete(output);
  }

  async function createClip() {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const workspace = await fs.mkdtemp(path.join(path.dirname(directory), "recall-work-"));
    const source = path.join(workspace, "source.mp4");
    const temporary = path.join(workspace, "clip.mp4");
    const failure = new AppError("storage_error", "匹配素材裁剪失败。", 500);
    try {
      await downloadSource(source);
      const { stdout } = await runMediaCommand("ffprobe", [
        "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries",
        "stream=duration,avg_frame_rate:format=duration", "-of", "json", source,
      ], failure);
      const probe = JSON.parse(stdout) as {
        streams?: Array<{ duration?: string; avg_frame_rate?: string }>;
        format?: { duration?: string };
      };
      const video = probe.streams?.[0];
      const sourceDuration = Number(video?.duration ?? probe.format?.duration);
      const [numerator, denominator = 1] = (video?.avg_frame_rate ?? "0").split("/").map(Number);
      const fps = numerator / denominator;
      if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(fps) || fps <= 0) {
        throw failure;
      }
      // 短素材直接返回原文件；不补帧、不循环、不拼接。
      if (sourceDuration * 1000 <= durationMs) return null;
      await runMediaCommand("ffmpeg", [
        "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", source,
        "-t", String(durationMs / 1000), "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", `fps=${video!.avg_frame_rate}`, "-frames:v", String(Math.max(1, Math.floor(durationMs * fps / 1000))),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", temporary,
      ], failure);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.rename(temporary, output);
      return output;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}
