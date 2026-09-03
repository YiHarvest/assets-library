import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface StoreFileInput {
  key: string;
  filePath: string;
  contentType: string;
}

export interface CopyObjectInput {
  sourceKey: string;
  destinationKey: string;
}

export interface StoredObject {
  key: string;
  sizeBytes: number;
  etag?: string;
  url?: string;
}

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface ObjectByteRange {
  start: number;
  end?: number;
}

export interface ObjectReadResult extends ObjectMetadata {
  body: ReadableStream<Uint8Array>;
  /** 本次响应体的字节数；Range 请求时可能小于对象总大小。 */
  contentLength: number;
  contentRange?: string;
}

/** 云端对象存储的最小能力，便于业务测试中使用内存或磁盘替身。 */
export interface ObjectStorage {
  storeFile(input: StoreFileInput): Promise<StoredObject>;
  copyObject(input: CopyObjectInput): Promise<StoredObject>;
  headObject(key: string): Promise<ObjectMetadata>;
  getObject(key: string, range?: ObjectByteRange): Promise<ObjectReadResult>;
  downloadToFile(key: string, destinationPath: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
}

/** FileHandle.write 允许短写；循环直到完整落盘，避免流分片被静默截断。 */
export async function writeAll(handle: FileHandle, chunk: Uint8Array) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten <= 0) throw new Error("文件写入未取得进展。");
    offset += bytesWritten;
  }
}

export function formatObjectRange(range: ObjectByteRange) {
  if (
    !Number.isSafeInteger(range.start) ||
    range.start < 0 ||
    (range.end !== undefined &&
      (!Number.isSafeInteger(range.end) || range.end < range.start))
  ) {
    throw new Error("对象读取范围无效。");
  }
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/** 对对象 key 做严格规范化，阻止绝对路径和 `..` 逃逸。 */
export function normalizeObjectKey(key: string) {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error("对象存储 key 无效。");
  }
  return normalized;
}

export function publicObjectUrl(baseUrl: string | undefined, key: string) {
  if (!baseUrl) return undefined;
  const normalizedKey = normalizeObjectKey(key);
  const encodedKey = normalizedKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${baseUrl.replace(/\/$/, "")}/${encodedKey}`;
}
