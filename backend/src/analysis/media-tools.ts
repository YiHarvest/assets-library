import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config";

const exec = promisify(execFile);

async function inTemporaryVideo<T>(bytes: Buffer, operation: (file: string, directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(tmpdir(), "assets-worker-"));
  const file = path.join(directory, "input.mp4");
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    return await operation(file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type VideoCompatibility = {
  codecName: string;
  pixelFormat: string | null;
  audioCodecName: string | null;
};

/** 浏览器侧冻结为 H.264 8-bit 4:2:0，音轨不存在或为 AAC。 */
export function isBrowserCompatibleMp4(video: VideoCompatibility) {
  return video.codecName === "h264"
    && video.pixelFormat === "yuv420p"
    && (video.audioCodecName === null || video.audioCodecName === "aac");
}

export async function probeVideo(bytes: Buffer, requireBrowserCompatible = false, signal?: AbortSignal) {
  const config = loadConfig();
  return inTemporaryVideo(bytes, async (file) => {
    const { stdout } = await exec(config.FFPROBE_PATH, ["-v", "error", "-show_entries", "format=duration,format_name:format_tags=major_brand:stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", file], { timeout: 30_000, maxBuffer: 1024 * 1024, signal });
    const payload = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
      streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number }>;
    };
    const stream = payload.streams?.find((item) => item.codec_type === "video");
    const audio = payload.streams?.find((item) => item.codec_type === "audio");
    const durationSeconds = Number(payload.format?.duration);
    const mp4 = bytes.subarray(4, 12).toString("ascii").includes("ftyp") && (payload.format?.format_name ?? "").split(",").includes("mov");
    if (!stream?.codec_name || !mp4 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("视频必须是包含可解码画面的有效 MP4。");
    const compatibility = {
      codecName: stream.codec_name,
      pixelFormat: stream.pix_fmt ?? null,
      audioCodecName: audio?.codec_name ?? null,
    };
    const browserCompatible = isBrowserCompatibleMp4(compatibility);
    if (requireBrowserCompatible && !browserCompatible) throw new Error("处理后的视频切片必须是 H.264/yuv420p MP4，音轨必须为 AAC。");
    // 完整解码，避免只验证容器头而接受中途损坏的视频。
    await exec(config.FFMPEG_PATH, ["-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0:V:0", "-an", "-sn", "-dn", "-f", "null", "-"], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, signal });
    return {
      durationSeconds,
      width: stream.width ?? null,
      height: stream.height ?? null,
      ...compatibility,
      majorBrand: payload.format?.tags?.major_brand ?? null,
      browserCompatible,
    };
  });
}

export async function normalizeVideoToH264(bytes: Buffer, signal?: AbortSignal) {
  const config = loadConfig();
  return inTemporaryVideo(bytes, async (file, directory) => {
    const output = path.join(directory, "normalized.mp4");
    await exec(config.FFMPEG_PATH, ["-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0:V:0", "-map", "0:a:0?", "-sn", "-dn", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4", "-y", output], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, signal });
    const normalized = await readFile(output);
    if (!normalized.length) throw new Error("视频转码结果为空。");
    return normalized;
  });
}

export async function createVideoCover(bytes: Buffer, signal?: AbortSignal) {
  const config = loadConfig();
  return inTemporaryVideo(bytes, async (file, directory) => {
    const output = path.join(directory, "cover.jpg");
    await exec(config.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0", "-i", file, "-frames:v", "1", "-q:v", "2", output], { timeout: 60_000, maxBuffer: 1024 * 1024, signal });
    const cover = await readFile(output);
    if (!cover.length) throw new Error("视频首帧提取结果为空。");
    return cover;
  });
}

export async function sampleVideoFrames(bytes: Buffer, durationSeconds: number, maximum = 5, signal?: AbortSignal) {
  const config = loadConfig();
  return inTemporaryVideo(bytes, async (file, directory) => {
    const count = Math.max(1, Math.min(maximum, Math.ceil(durationSeconds)));
    const timestamps = Array.from({ length: count }, (_, index) => Number((((index + 0.5) / count) * durationSeconds).toFixed(3)));
    return Promise.all(timestamps.map(async (timestamp, index) => {
      const output = path.join(directory, `frame-${index}.jpg`);
      await exec(config.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(timestamp), "-i", file, "-frames:v", "1", "-q:v", "3", output], { timeout: 60_000, maxBuffer: 1024 * 1024, signal });
      return { timestampSeconds: timestamp, bytes: await readFile(output) };
    }));
  });
}
