export class UploadObjectTooLargeError extends Error {
  constructor(
    public readonly mediaType: "image" | "video",
    public readonly sizeBytes: number,
    public readonly limitBytes: number,
  ) {
    super(`${mediaType === "image" ? "图片" : "视频"}超过允许的上传大小。`);
    this.name = "UploadObjectTooLargeError";
  }
}

export function isStorageObjectMissingError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = String(value.name ?? value.Code ?? value.code ?? "");
  return value.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound", "NoSuchObject"].includes(name);
}

export function assertUploadObjectSize(
  mediaType: "image" | "video",
  sizeBytes: number,
  maximumImageBytes: number,
  maximumVideoBytes: number,
) {
  const limit = mediaType === "image" ? maximumImageBytes : maximumVideoBytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > limit) {
    throw new UploadObjectTooLargeError(mediaType, sizeBytes, limit);
  }
}

export async function inspectUploadedObject<T extends { sizeBytes: number }>(
  input: { mediaType: "image" | "video"; objectKey: string },
  storage: { head(key: string): Promise<T>; delete(key: string): Promise<unknown> },
  limits: { imageBytes: number; videoBytes: number },
) {
  const head = await storage.head(input.objectKey);
  try {
    assertUploadObjectSize(input.mediaType, head.sizeBytes, limits.imageBytes, limits.videoBytes);
  } catch (error) {
    await storage.delete(input.objectKey).catch(() => undefined);
    throw error;
  }
  return head;
}
