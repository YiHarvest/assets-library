import crypto from "node:crypto";
import fs from "node:fs";
import { AppError } from "@/server/errors";
import type { MediaType } from "@/shared/contracts";
import type { StoredMediaExtension } from "./target-format";

export interface ValidatedMedia {
  mediaType: MediaType;
  mimeType: string;
  extension: StoredMediaExtension;
  sizeBytes: number;
}

export interface MediaSizeLimit {
  mediaLabel: "图片" | "视频";
  maximumBytes: number;
}

const normalizedOutputLimitDetectionRatio = 0.9;

function fileTooLargeError(
  limit: MediaSizeLimit,
  phase: "source" | "normalized",
) {
  const subject =
    phase === "normalized" ? `转换后的${limit.mediaLabel}` : limit.mediaLabel;
  return new AppError(
    "file_too_large",
    `${subject}不得超过 ${Math.round(limit.maximumBytes / 1024 / 1024)} MB。`,
  );
}

function storageError(filePath: string, error: unknown) {
  const errno = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
  const originalMessage =
    error instanceof Error ? error.message : String(error ?? "未知错误");
  return new AppError(
    "storage_error",
    undefined,
    500,
    { errno, path: filePath, originalMessage },
    { cause: error },
  );
}

/**
 * 读取文件大小。
 *
 * 文件刚经原子落盘（.uploading 临时文件 + fsync + rename）时，存储层瞬时
 * 抖动会让 stat 短暂报 ENOENT，这里先短重试几次；仍失败时把底层 errno、
 * 路径和原始信息随 AppError.details 透传，避免再次出现无法定位的诊断黑洞。
 */
export async function mediaSize(filePath: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await fs.promises.stat(filePath)).size;
    } catch (error) {
      lastError = error;
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== "ENOENT" || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw storageError(filePath, lastError);
}

export async function mediaSizeOrZero(filePath: string) {
  return fs.promises
    .stat(filePath)
    .then((stat) => stat.size)
    .catch(() => 0);
}

export function assertSourceMediaSize(
  sizeBytes: number,
  limit: MediaSizeLimit,
) {
  if (sizeBytes === 0) throw new AppError("corrupt_file");
  if (sizeBytes > limit.maximumBytes) {
    throw fileTooLargeError(limit, "source");
  }
}

function assertNormalizedMediaSize(
  sizeBytes: number,
  limit: MediaSizeLimit,
) {
  if (sizeBytes === 0) throw new AppError("corrupt_file");
  if (sizeBytes > limit.maximumBytes) {
    throw fileTooLargeError(limit, "normalized");
  }
}

export function throwIfNormalizedOutputLikelyReachedLimit(
  sizeBytes: number,
  limit: MediaSizeLimit,
) {
  if (sizeBytes >= limit.maximumBytes * normalizedOutputLimitDetectionRatio) {
    throw fileTooLargeError(limit, "normalized");
  }
}

export async function replaceWithNormalizedMedia(
  filePath: string,
  limit: MediaSizeLimit,
  writeNormalized: (temporaryPath: string) => Promise<void>,
  validateNormalized?: (
    temporaryPath: string,
    normalizedSize: number,
  ) => Promise<void>,
) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.normalized`;
  try {
    await writeNormalized(temporaryPath);
    const normalizedSize = await mediaSize(temporaryPath);
    assertNormalizedMediaSize(normalizedSize, limit);
    await validateNormalized?.(temporaryPath, normalizedSize);
    try {
      await fs.promises.rename(temporaryPath, filePath);
    } catch {
      throw new AppError("storage_error");
    }
    return normalizedSize;
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
