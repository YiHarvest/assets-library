import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AppError } from "@/server/errors";
import { loadConfig } from "@/server/config";
import { runH264Encode, runMediaCommand } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";

const pending = new Map<string, Promise<string | null>>();
// 每个 Web 进程最多同时准备两个片段，避免下游批量下载时挤占全部转码资源。
const lanes = [Promise.resolve(), Promise.resolve()];

/** 按原对象版本和目标时长缓存；复用 staging 清理，缓存过期后可重新生成。 */
export async function prepareVideoClip(
  sourceVersion: string,
  durationMs: number,
  downloadSource: (destination: string) => Promise<unknown>,
  stillImage = false,
  additionalSources: Array<(destination: string) => Promise<unknown>> = [],
) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new AppError("invalid_request", "裁剪时长必须是正整数毫秒。", 400);
  }
  const key = createHash("sha256").update(`${additionalSources.length ? "concat:" : stillImage ? "still:" : ""}${sourceVersion}:${durationMs}`).digest("hex");
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
      let inputArgs: string[];
      let outputArgs: string[];
      let outputDurationMs = durationMs;
      if (additionalSources.length) {
        const minVideoDurationMs = loadConfig().SEGMENT_MATCH_MIN_VIDEO_DURATION_MS;
        const files = [source];
        for (const [index, download] of additionalSources.entries()) {
          const file = path.join(workspace, `source-${index + 1}.mp4`);
          await download(file);
          files.push(file);
        }
        const probes = [];
        for (const file of files) {
          const { stdout } = await runMediaCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
            "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", file], failure);
          const probe = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number; duration?: string }>; format: { duration?: string } };
          const video = probe.streams.find(stream => stream.codec_type === "video");
          const duration = Number(video?.duration ?? probe.format.duration);
          // 兼容旧组合中不足 3 秒的成员，新组合的成员时长由配置限制。
          if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0 || duration * 1000 >= Math.max(3000, minVideoDurationMs)) throw failure;
          probes.push({ width: video.width, height: video.height, duration, audio: probe.streams.some(stream => stream.codec_type === "audio") });
        }
        const totalMs = Math.round(probes.reduce((sum, probe) => sum + probe.duration * 1000, 0));
        if (totalMs < minVideoDurationMs) throw new AppError("invalid_request", `短视频组合实际时长不足 ${minVideoDurationMs / 1000} 秒。`, 400);
        outputDurationMs = Math.min(durationMs, totalMs);
        const width = Math.ceil(probes[0].width / 2) * 2, height = Math.ceil(probes[0].height / 2) * 2;
        const filters = probes.flatMap((probe, i) => {
          const seconds = Math.ceil(probe.duration * 25) / 25;
          return [
            `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=0.04,trim=duration=${seconds},setpts=PTS-STARTPTS[v${i}]`,
            `${probe.audio ? `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad` : "anullsrc=r=48000:cl=stereo"},atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${i}]`,
          ];
        });
        filters.push(probes.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${files.length}:v=1:a=1[v][a]`);
        inputArgs = files.flatMap(file => ["-protocol_whitelist", "file,pipe", "-i", file]);
        outputArgs = ["-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
          "-frames:v", String(Math.max(1, Math.floor(outputDurationMs * 25 / 1000))), "-c:a", "aac"];
      } else if (stillImage) {
        const image = path.join(workspace, "still.png");
        // 统一图片格式、应用 EXIF 方向，动画图片也只取第一帧。
        await sharp(source).rotate().png().toFile(image);
        inputArgs = ["-loop", "1", "-framerate", "25", "-i", image];
        outputArgs = ["-an", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"];
      } else {
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
        // 已通过候选时长门槛的视频若短于目标时段，直接使用原文件，不循环补齐。
        if (sourceDuration * 1000 <= durationMs) return null;
        inputArgs = ["-ss", "0", "-i", source];
        outputArgs = ["-map", "0:v:0", "-map", "0:a:0?",
          "-vf", `fps=${video!.avg_frame_rate}`, "-frames:v", String(Math.max(1, Math.floor(durationMs * fps / 1000))),
          "-c:a", "aac"];
      }
      await runH264Encode([
        "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", ...inputArgs,
        "-t", String(outputDurationMs / 1000), ...outputArgs,
      ], temporary, failure, stillImage);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.rename(temporary, output);
      return output;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}
