import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/server/errors";
import { runMediaCommand } from "@/server/media/ffmpeg";

/** 二次切分后产出的子切片（尚未落到最终编号路径）。 */
export interface ResplitPiece {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sizeBytes: number;
  /** 切分落盘的临时文件，调用方负责重命名到最终路径。 */
  temporaryPath: string;
}

const copyFailure = new AppError(
  "corrupt_file",
  "视频二次切分失败：切片无法以流复制方式截取。",
);

/** 复制切分的最小时长；低于该时长仍超限则放弃 copy 走重编码兜底。 */
const MINIMUM_COPY_CHUNK_SECONDS = 0.5;
/** copy 段允许的最后一次大小校验的重试轮数；仍超限则缩短时长继续。 */
const MAX_COPY_ATTEMPTS_PER_CHUNK = 4;
/** 重编码子切片的时长下限；低于该时长不再缩短，直接以最小码率切完剩余部分。 */
const MINIMUM_REENCODE_CHUNK_SECONDS = 0.25;
/** 重编码兜底的码率保险系数：以 85% 预算估算码率，避免 mux 开销导致超限。 */
const REENCODE_BYTES_SAFETY = 0.85;

function probeFailure() {
  return new AppError(
    "corrupt_file",
    "视频二次切分失败：无法读取切片码率信息。",
  );
}

async function probeBitrate(inputPath: string) {
  const { stdout } = await runMediaCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "V:0",
      "-show_entries",
      "stream=bit_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    probeFailure(),
  );
  const value = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 以流复制方式从父视频截取 [start, end) 切片，返回实际字节数。 */
async function cutCopy(
  parentPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<number> {
  await runMediaCommand(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-ss",
      String(startSeconds),
      "-to",
      String(endSeconds),
      "-i",
      parentPath,
      "-map",
      "0:V:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      outputPath,
    ],
    copyFailure,
    300_000,
  );
  return (await fs.stat(outputPath)).size;
}

/** 重编码兜底：按目标码率输出，文件大小可预期地不超过限制。 */
async function cutReencode(
  parentPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  maximumBytes: number,
) {
  const bitrateK = Math.max(
    100,
    Math.round(
      ((maximumBytes * REENCODE_BYTES_SAFETY) * 8) /
        durationSeconds /
        1000,
    ),
  );
  const failure = new AppError(
    "corrupt_file",
    "视频二次切分失败：切片无法以受控码率重新编码。",
  );
  await runMediaCommand(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-ss",
      String(startSeconds),
      "-i",
      parentPath,
      "-t",
      String(durationSeconds),
      "-map",
      "0:V:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-b:v",
      `${bitrateK}k`,
      "-maxrate",
      `${bitrateK}k`,
      "-bufsize",
      `${Math.max(bitrateK * 2, bitrateK)}k`,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      outputPath,
    ],
    failure,
    300_000,
  );
  return (await fs.stat(outputPath)).size;
}

/**
 * 把单个超过大小上限的分镜硬切分成多个不超过上限的子切片。
 *
 * 优先用流复制（-c copy，关键帧对齐，近零开销）；若复制段仍超限则缩短
 * 目标时长重试，连续超限说明关键帧间隔过大（每段至少一个 GOP），切换为
 * 逐块重编码兜底：每个子切片独立估算码率，保证大小可控且画质均衡。
 */
export async function resplitSegment(
  parentPath: string,
  startSeconds: number,
  endSeconds: number,
  maximumBytes: number,
  workspacePath: string,
): Promise<ResplitPiece[]> {
  const pieces: ResplitPiece[] = [];
  const bitrate = await probeBitrate(parentPath);
  let chunkSeconds =
    bitrate === null
      ? Math.max(1, endSeconds - startSeconds)
      : Math.max(
          1,
          ((maximumBytes * 8) / bitrate) * 0.85,
        );
  let cursor = startSeconds;
  let copyAttemptIndex = 0;
  let reencodeMode = false;
  const outputDirectory = path.join(workspacePath, ".resplit");
  await fs.mkdir(outputDirectory, { recursive: true });
  try {
    while (cursor < endSeconds) {
      const remaining = endSeconds - cursor;
      const chunk = Math.min(chunkSeconds, remaining);
      const temporaryPath = path.join(
        outputDirectory,
        `${crypto.randomUUID()}.mp4`,
      );
      if (!reencodeMode && chunk >= MINIMUM_COPY_CHUNK_SECONDS) {
        const sizeBytes = await cutCopy(
          parentPath,
          temporaryPath,
          cursor,
          cursor + chunk,
        );
        if (sizeBytes <= maximumBytes) {
          pieces.push({
            startSeconds: cursor,
            endSeconds: cursor + chunk,
            durationSeconds: chunk,
            sizeBytes,
            temporaryPath,
          });
          cursor += chunk;
          chunkSeconds = Math.min(chunkSeconds * 1.1, endSeconds - cursor);
          copyAttemptIndex = 0;
          continue;
        }
        await fs.rm(temporaryPath, { force: true });
        copyAttemptIndex += 1;
        if (copyAttemptIndex >= MAX_COPY_ATTEMPTS_PER_CHUNK) {
          // copy 连续超限说明该视频关键帧间隔过大，缩短时长无法缩小
          // 段大小（每段至少一个完整 GOP），切换到逐块重编码兜底。
          reencodeMode = true;
          continue;
        }
        chunkSeconds = Math.max(MINIMUM_COPY_CHUNK_SECONDS, chunkSeconds * 0.7);
        continue;
      }

      if (chunk < MINIMUM_REENCODE_CHUNK_SECONDS) {
        // 时长已无法再缩短，以最小码率切完剩余部分收尾。
        const sizeBytes = await cutReencode(
          parentPath,
          temporaryPath,
          cursor,
          remaining,
          maximumBytes,
        );
        if (sizeBytes > maximumBytes) {
          throw new AppError(
            "corrupt_file",
            "视频二次切分失败：最短重编码切片仍超过大小限制。",
            400,
            { actualBytes: sizeBytes, maximumBytes },
          );
        }
        pieces.push({
          startSeconds: cursor,
          endSeconds,
          durationSeconds: remaining,
          sizeBytes,
          temporaryPath,
        });
        break;
      }
      const sizeBytes = await cutReencode(
        parentPath,
        temporaryPath,
        cursor,
        chunk,
        maximumBytes,
      );
      if (sizeBytes <= maximumBytes) {
        pieces.push({
          startSeconds: cursor,
          endSeconds: cursor + chunk,
          durationSeconds: chunk,
          sizeBytes,
          temporaryPath,
        });
        cursor += chunk;
        chunkSeconds = Math.min(
          Math.max(MINIMUM_REENCODE_CHUNK_SECONDS, chunkSeconds * 1.1),
          endSeconds - cursor,
        );
        continue;
      }
      await fs.rm(temporaryPath, { force: true });
      chunkSeconds = Math.max(
        MINIMUM_REENCODE_CHUNK_SECONDS,
        chunkSeconds * 0.7,
      );
    }
    return pieces;
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}
