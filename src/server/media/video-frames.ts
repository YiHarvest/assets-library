import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "@/server/errors";
import { loadConfig } from "@/server/config";
import { runMediaCommand } from "./ffmpeg";
import { temporaryUploadPath } from "./storage";
import {
  MAX_VIDEO_FRAMES,
  videoFrameTimestamps,
  type VideoFrameManifest,
  type VideoFrameUploadMetadata,
} from "@/shared/video-frames";

// 单次探测 cuda 硬解可用性并缓存；真实输入失败后 auto 也会永久回退 CPU。
let cudaDecodeAvailable: boolean | undefined;
async function cudaDecodeArgs(): Promise<string[]> {
  if (cudaDecodeAvailable === undefined) {
    const config = loadConfig();
    if (config.FFMPEG_HW_ACCEL === "none") {
      cudaDecodeAvailable = false;
    } else {
      try {
        // 用 lavfi 源实际解码一帧；runMediaCommand 失败即抛出 AppError
        await runMediaCommand(
          "ffmpeg",
          [
            "-v",
            "error",
            "-hwaccel",
            "cuda",
            "-f",
            "lavfi",
            "-i",
            "color=black:size=16x16:rate=1",
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
          ],
          new AppError("internal_error", "cuda 探测失败", 500),
          10_000,
        );
        cudaDecodeAvailable = true;
      } catch {
        cudaDecodeAvailable = false;
      }
    }
  }
  return cudaDecodeAvailable ? ["-hwaccel", "cuda"] : [];
}

async function run(command: "ffmpeg" | "ffprobe", args: string[]) {
  return runMediaCommand(
    command,
    args,
    new AppError(
      "invalid_video_frames",
      "服务端无法提取视频关键帧，请确认视频可正常播放。",
    ),
  );
}

/** 使用同一套 FFmpeg 参数抽取单帧，并确保失败时不留下半张图片。 */
async function extractFrame(
  inputPath: string,
  outputPath: string,
  timestampSeconds?: number,
) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const commandArguments = (hardwareArguments: string[]) => [
    "-nostdin",
    "-v",
    "error",
    ...hardwareArguments,
    ...(timestampSeconds === undefined
      ? []
      : ["-ss", String(timestampSeconds)]),
    "-i",
    inputPath,
    "-map",
    "0:V:0",
    "-vf",
    "scale=w='min(640,iw)':h=-2",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    "-f",
    "image2",
    "-y",
    outputPath,
  ];
  try {
    const hardwareArguments = await cudaDecodeArgs();
    try {
      await run("ffmpeg", commandArguments(hardwareArguments));
    } catch (error) {
      if (
        hardwareArguments.length === 0 ||
        loadConfig().FFMPEG_HW_ACCEL !== "auto"
      ) {
        throw error;
      }
      // 探测通过不代表当前视频编码格式可被 GPU 解码；清掉半张图片后用 CPU 重试。
      cudaDecodeAvailable = false;
      fs.rmSync(outputPath, { force: true });
      await run("ffmpeg", commandArguments([]));
    }
    if (!fs.existsSync(outputPath)) {
      throw new AppError("invalid_video_frames");
    }
    const sizeBytes = fs.statSync(outputPath).size;
    if (sizeBytes <= 0) throw new AppError("invalid_video_frames");
    return sizeBytes;
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

/**
 * 抽取视频的第一张可解码画面，供素材列表缩略图长期持久化。
 *
 * outputPath 由调用方放入当前分镜工作区，整批失败时可与切片一起原子清理。
 */
export async function extractVideoFirstFrame(
  inputPath: string,
  outputPath: string,
) {
  const sizeBytes = await extractFrame(inputPath, outputPath);
  return { absolutePath: outputPath, sizeBytes };
}

async function videoFrameMetadata(
  inputPath: string,
): Promise<VideoFrameUploadMetadata> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "V:0",
    "-show_entries",
    "stream=duration:format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ]);
  const durationSeconds = Number.parseFloat(stdout.trim());
  let timestamps: number[];
  try {
    timestamps = videoFrameTimestamps(durationSeconds);
  } catch {
    throw new AppError(
      "invalid_video_frames",
      "无法读取视频时长，请确认视频可正常播放。",
    );
  }
  if (timestamps.length > MAX_VIDEO_FRAMES) {
    throw new AppError("invalid_video_frames");
  }
  return { durationSeconds, timestamps };
}

/**
 * 在分镜仍位于本地工作区时直接生成分析关键帧，后续 analyze worker 可复用该目录。
 * 目录通过临时路径原子替换，失败时不会暴露半套帧或清单。
 */
export async function extractVideoFramesToDirectory(
  inputPath: string,
  frameDirectory: string,
) {
  const metadata = await videoFrameMetadata(inputPath);
  const stagingDirectory = `${frameDirectory}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const frames: VideoFrameManifest["frames"] = [];
    for (const [index, timestampSeconds] of metadata.timestamps.entries()) {
      const filename = `frame-${String(index + 1).padStart(2, "0")}.jpg`;
      await extractFrame(
        inputPath,
        path.join(stagingDirectory, filename),
        timestampSeconds,
      );
      frames.push({ filename, timestampSeconds });
    }
    const manifest = {
      durationSeconds: metadata.durationSeconds,
      frames,
    } satisfies VideoFrameManifest;
    fs.writeFileSync(
      path.join(stagingDirectory, "manifest.json"),
      JSON.stringify(manifest),
    );
    fs.rmSync(frameDirectory, { recursive: true, force: true });
    fs.renameSync(stagingDirectory, frameDirectory);
    return metadata;
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function extractVideoFrames(inputPath: string): Promise<{
  uploads: Array<{ temporaryPath: string; timestampSeconds: number }>;
  metadata: VideoFrameUploadMetadata;
}> {
  const metadata = await videoFrameMetadata(inputPath);
  const uploads: Array<{ temporaryPath: string; timestampSeconds: number }> = [];
  try {
    for (const timestampSeconds of metadata.timestamps) {
      const temporaryPath = temporaryUploadPath(crypto.randomUUID());
      uploads.push({ temporaryPath, timestampSeconds });
      await extractFrame(inputPath, temporaryPath, timestampSeconds);
    }
    return { uploads, metadata };
  } catch (error) {
    for (const frame of uploads) {
      try { fs.rmSync(frame.temporaryPath, { force: true }); } catch { /* best effort */ }
    }
    throw error;
  }
}
