import { AppError } from "@/server/errors";
import { runMediaCommand } from "./ffmpeg";
import type { MediaTargetFormat } from "./target-format";
import {
  assertSourceMediaSize,
  mediaSizeOrZero,
  replaceWithNormalizedMedia,
  throwIfNormalizedOutputLikelyReachedLimit,
  type MediaSizeLimit,
  type ValidatedMedia,
} from "./validation-size";

interface ProbedVideo {
  audioCodecName: string | null;
  codecName: string;
  durationSeconds: number;
  formatNames: Set<string>;
  majorBrand: string;
  pixelFormat: string;
}

interface ProbePayload {
  format?: {
    duration?: string;
    format_name?: string;
    tags?: { major_brand?: string };
  };
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    disposition?: { attached_pic?: number };
    duration?: string;
    height?: number;
    pix_fmt?: string;
    width?: number;
  }>;
}

// Only self-contained media containers are accepted. In particular, playlist
// and image demuxers are excluded so an uploaded file cannot make FFmpeg fetch
// remote resources or turn a renamed still image into a one-frame video.
const videoInputFormats = [
  "asf",
  "avi",
  "flv",
  "matroska",
  "webm",
  "mov",
  "mpeg",
  "mpegts",
  "mxf",
  "nut",
  "ogg",
  "rm",
].join(",");
const localMediaProtocols = "file,pipe";
const mp4MajorBrands = new Set([
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "m4v",
  "mp41",
  "mp42",
  "msnv",
]);

function positiveNumber(...values: Array<string | undefined>) {
  for (const value of values) {
    const number = Number.parseFloat(value ?? "");
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

async function probeVideo(filePath: string): Promise<ProbedVideo> {
  const corruptVideo = new AppError(
    "corrupt_file",
    "视频已损坏、没有可解码画面，或不是受支持的本地视频文件。",
  );
  const { stdout } = await runMediaCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      localMediaProtocols,
      "-format_whitelist",
      videoInputFormats,
      "-show_entries",
      "format=format_name,duration:format_tags=major_brand:stream=codec_type,codec_name,pix_fmt,width,height,duration:stream_disposition=attached_pic",
      "-of",
      "json",
      filePath,
    ],
    corruptVideo,
  );
  let payload: ProbePayload;
  try {
    payload = JSON.parse(stdout) as ProbePayload;
  } catch {
    throw corruptVideo;
  }
  const stream = payload.streams?.find(
    (candidate) =>
      candidate.codec_type === "video" &&
      candidate.disposition?.attached_pic !== 1,
  );
  const durationSeconds = positiveNumber(
    stream?.duration,
    payload.format?.duration,
  );
  if (
    !stream?.codec_name ||
    !stream.width ||
    !stream.height ||
    !durationSeconds
  ) {
    throw corruptVideo;
  }
  return {
    audioCodecName:
      payload.streams?.find((candidate) => candidate.codec_type === "audio")
        ?.codec_name ?? null,
    codecName: stream.codec_name,
    durationSeconds,
    formatNames: new Set(
      (payload.format?.format_name ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
    majorBrand: payload.format?.tags?.major_brand?.trim() ?? "",
    pixelFormat: stream.pix_fmt ?? "",
  };
}

function isBrowserCompatibleMp4(probe: ProbedVideo) {
  return (
    probe.formatNames.has("mov") &&
    mp4MajorBrands.has(probe.majorBrand.toLowerCase()) &&
    probe.codecName === "h264" &&
    probe.pixelFormat === "yuv420p" &&
    (!probe.audioCodecName || probe.audioCodecName === "aac")
  );
}

async function validateDecodedVideo(filePath: string) {
  await runMediaCommand(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-protocol_whitelist",
      localMediaProtocols,
      "-format_whitelist",
      videoInputFormats,
      "-err_detect",
      "explode",
      "-i",
      filePath,
      "-map",
      "0:V:0",
      "-an",
      "-sn",
      "-dn",
      "-f",
      "null",
      "-",
    ],
    new AppError(
      "corrupt_file",
      "视频已损坏或存在无法解码的画面，请更换文件。",
    ),
    300_000,
  );
}

function durationMatches(sourceSeconds: number, outputSeconds: number) {
  const tolerance = 0.1;
  return Math.abs(sourceSeconds - outputSeconds) <= tolerance;
}

async function normalizeVideoFormat(
  filePath: string,
  sourceProbe: ProbedVideo,
  sizeLimit: MediaSizeLimit,
) {
  const canCopyVideo =
    sourceProbe.codecName === "h264" &&
    sourceProbe.pixelFormat === "yuv420p";
  const videoCodecArgs = canCopyVideo
    ? ["-c:v", "copy"]
    : [
        "-vf",
        "scale=in_range=auto:out_range=tv",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
      ];
  return replaceWithNormalizedMedia(
    filePath,
    sizeLimit,
    async (temporaryPath) => {
      try {
        await runMediaCommand(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-protocol_whitelist",
            localMediaProtocols,
            "-format_whitelist",
            videoInputFormats,
            "-err_detect",
            "explode",
            "-i",
            filePath,
            "-map",
            "0:V:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            ...videoCodecArgs,
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-fs",
            String(sizeLimit.maximumBytes),
            "-f",
            "mp4",
            "-y",
            temporaryPath,
          ],
          new AppError(
            "corrupt_file",
            "视频已损坏、没有可解码画面，或无法转换为 H.264 MP4。",
          ),
          300_000,
        );
      } catch (error) {
        const partialSize = await mediaSizeOrZero(temporaryPath);
        throwIfNormalizedOutputLikelyReachedLimit(partialSize, sizeLimit);
        throw error;
      }
    },
    async (temporaryPath, normalizedSize) => {
      const outputProbe = await probeVideo(temporaryPath);
      if (!isBrowserCompatibleMp4(outputProbe)) {
        throw new AppError(
          "corrupt_file",
          "视频无法转换为兼容的 H.264 MP4。",
        );
      }
      await validateDecodedVideo(temporaryPath);
      if (
        !durationMatches(
          sourceProbe.durationSeconds,
          outputProbe.durationSeconds,
        )
      ) {
        throwIfNormalizedOutputLikelyReachedLimit(normalizedSize, sizeLimit);
        throw new AppError(
          "corrupt_file",
          "视频转换后时长不完整，请更换文件。",
        );
      }
    },
  );
}

export async function validateVideoFile(
  filePath: string,
  target: MediaTargetFormat,
  sizeBytes: number,
  maximumBytes: number,
): Promise<ValidatedMedia> {
  const sizeLimit = { mediaLabel: "视频", maximumBytes } as const;
  assertSourceMediaSize(sizeBytes, sizeLimit);
  const sourceProbe = await probeVideo(filePath);
  await validateDecodedVideo(filePath);
  const normalizedSize = isBrowserCompatibleMp4(sourceProbe)
    ? sizeBytes
    : await normalizeVideoFormat(filePath, sourceProbe, sizeLimit);
  return {
    mediaType: "video",
    mimeType: target.mimeType,
    extension: target.extension,
    sizeBytes: normalizedSize,
  };
}
