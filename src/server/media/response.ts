import fs from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { mediaObjects } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { resolveMediaPath } from "@/server/media/storage";
import { prepareVideoClip } from "@/server/media/video-clip";
import { getAssetDetail, getAssetRecord } from "@/server/repositories/assets";
import { userIdSchema } from "@/shared/contracts";
import { getAssetThumbnailObject } from "@/server/repositories/user-media";
import type { ObjectStorage } from "@/server/storage/object-storage";
import { createZosObjectStorage } from "@/server/storage/zos";

const mediaReadyFailureCodes = new Set([
  "invalid_video_frames",
  "model_not_configured",
  "model_video_unsupported",
  "video_frames_missing",
  "model_request_failed",
  "model_response_invalid",
]);

type AssetRecord = NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>;

export interface MediaByteRange {
  start: number;
  end: number;
}

let sharedZosStorage: ObjectStorage | undefined;

function zosStorage() {
  sharedZosStorage ??= createZosObjectStorage();
  return sharedZosStorage;
}

function mediaIsReady(
  asset: Pick<AssetRecord, "processingStatus" | "failureCode">,
) {
  if (
    asset.processingStatus === "analyzing" ||
    asset.processingStatus === "completed"
  ) {
    return true;
  }
  return (
    asset.processingStatus === "failed" &&
    Boolean(asset.failureCode && mediaReadyFailureCodes.has(asset.failureCode))
  );
}

/**
 * 解析单段 HTTP Range。返回 undefined 表示语法或范围不可满足，null 表示未请求 Range。
 * 同时支持视频播放器常用的开放范围与后缀范围，例如 bytes=100-、bytes=-500。
 */
export function parseMediaByteRange(
  value: string | null,
  sizeBytes: number,
): MediaByteRange | null | undefined {
  if (!value) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2]!, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(0, sizeBytes - suffixLength),
      end: sizeBytes - 1,
    };
  }

  const start = Number.parseInt(match[1], 10);
  const requestedEnd = match[2]
    ? Number.parseInt(match[2], 10)
    : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= sizeBytes ||
    requestedEnd < start
  ) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

interface MediaPresentation {
  mimeType: string;
  filename: string;
}

function responseHeaders(media: MediaPresentation, download: boolean) {
  return {
    "Content-Type": media.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
    "X-Content-Type-Options": "nosniff",
  };
}

function rangeNotSatisfiable(sizeBytes: number) {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${sizeBytes}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}

async function localMediaResponse(
  media: MediaPresentation,
  localPath: string,
  request: Request,
) {
  const filePath = resolveMediaPath(localPath);
  if (!fs.existsSync(filePath)) {
    throw new AppError("storage_error", "媒体文件不存在。", 404);
  }
  const sizeBytes = fs.statSync(filePath).size;
  const range = parseMediaByteRange(request.headers.get("range"), sizeBytes);
  if (range === undefined) return rangeNotSatisfiable(sizeBytes);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers = responseHeaders(media, download);
  if (!range) {
    return new Response(
      Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream,
      {
        status: 200,
        headers: { ...headers, "Content-Length": String(sizeBytes) },
      },
    );
  }
  return new Response(
    Readable.toWeb(
      fs.createReadStream(filePath, { start: range.start, end: range.end }),
    ) as ReadableStream,
    {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${sizeBytes}`,
      },
    },
  );
}

async function zosMediaResponse(
  media: MediaPresentation,
  objectKey: string,
  sizeBytes: number,
  request: Request,
  storage: ObjectStorage,
) {
  const range = parseMediaByteRange(request.headers.get("range"), sizeBytes);
  if (range === undefined) return rangeNotSatisfiable(sizeBytes);
  const result = await storage.getObject(
    objectKey,
    range ? { start: range.start, end: range.end } : undefined,
  );
  if (result.sizeBytes !== sizeBytes) {
    await result.body.cancel().catch(() => undefined);
    throw new AppError("storage_error", "ZOS 对象大小与数据库记录不一致。", 502);
  }
  if (range) {
    const expectedLength = range.end - range.start + 1;
    const expectedContentRange = `bytes ${range.start}-${range.end}/${sizeBytes}`;
    if (
      result.contentLength !== expectedLength ||
      result.contentRange !== expectedContentRange
    ) {
      await result.body.cancel().catch(() => undefined);
      throw new AppError("storage_error", "ZOS 未正确响应媒体 Range 请求。", 502);
    }
  } else if (result.contentLength !== sizeBytes) {
    await result.body.cancel().catch(() => undefined);
    throw new AppError("storage_error", "ZOS 返回的媒体内容不完整。", 502);
  }
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    ...responseHeaders(media, download),
    "Content-Length": String(result.contentLength),
  };
  if (range) {
    headers["Content-Range"] = result.contentRange!;
  }
  return new Response(result.body, { status: range ? 206 : 200, headers });
}

type StoredMediaObject = typeof mediaObjects.$inferSelect;

async function downloadMediaObject(object: StoredMediaObject, destination: string) {
  if (object.provider === "local") {
    if (!object.localPath) throw new AppError("storage_error", "本地媒体对象缺少存储路径。", 500);
    await fs.promises.copyFile(resolveMediaPath(object.localPath), destination);
  } else {
    await zosStorage().downloadToFile(object.objectKey, destination);
  }
}

export async function mediaObjectResponse(
  object: StoredMediaObject,
  media: MediaPresentation,
  request: Request,
  storage?: ObjectStorage,
) {
  if (object.status !== "persisted") {
    throw new AppError("storage_error", "素材的持久化对象不存在。", 404);
  }
  if (object.provider === "local") {
    if (!object.localPath) {
      throw new AppError("storage_error", "本地媒体对象缺少存储路径。", 500);
    }
    return localMediaResponse(media, object.localPath, request);
  }
  return zosMediaResponse(
    media,
    object.objectKey,
    object.sizeBytes,
    request,
    storage ?? zosStorage(),
  );
}

/** 按 media_objects 的实际 provider 返回媒体，持久化到 ZOS 后不再依赖本地 staging。 */
export async function mediaResponse(assetId: string, request: Request) {
  const asset = await getAssetRecord(assetId);
  if (!asset || asset.deletedAt || asset.reviewStatus === "deleted") {
    throw new AppError("invalid_request", "素材不存在。", 404);
  }
  if (!mediaIsReady(asset)) {
    throw new AppError(
      "invalid_request",
      "素材完成媒体校验后才可预览或下载。",
      409,
    );
  }
  if (!asset.mediaObjectId) {
    throw new AppError("storage_error", "素材缺少持久化对象记录。", 500);
  }
  const [object] = await db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, asset.mediaObjectId))
    .limit(1);
  if (!object) {
    throw new AppError("storage_error", "素材的持久化对象不存在。", 404);
  }
  const params = new URL(request.url).searchParams;
  const clipMs = params.get("clip_ms");
  if (params.has("concat")) {
    let parts: Array<{ assetId: string; userId: string | null }>;
    try {
      parts = z.array(z.object({ assetId: z.string().uuid(), userId: userIdSchema.nullable() }).strict()).min(2).max(100)
        .parse(JSON.parse(Buffer.from(params.get("concat")!, "base64url").toString("utf8")));
      if (parts[0].assetId !== assetId || new Set(parts.map(part => part.assetId.toLowerCase())).size !== parts.length || params.has("still_ms")) throw new Error();
    } catch {
      throw new AppError("invalid_request", "短视频组合参数无效。", 400);
    }
    const objects: StoredMediaObject[] = [];
    let totalMs = 0;
    for (const part of parts) {
      // 每个组成素材都重新执行原有作用域检查，缓存命中也不能绕过权限或删除状态。
      const detail = await getAssetDetail(part.assetId, part.userId ? { userId: part.userId } : {});
      const durationMs = (detail.segmentEndMs ?? 0) - (detail.segmentStartMs ?? 0);
      const record = part.assetId === assetId ? asset : await getAssetRecord(part.assetId);
      if (!record || record.deletedAt || record.reviewStatus === "deleted" || !mediaIsReady(record) ||
        detail.mediaType !== "video" || durationMs <= 0 || durationMs >= 3000) {
        throw new AppError("invalid_request", "短视频组合中的素材已不可用。", 404);
      }
      const [stored] = part.assetId === assetId ? [object] : await db.select().from(mediaObjects)
        .where(eq(mediaObjects.id, record.mediaObjectId!)).limit(1);
      if (!stored || stored.status !== "persisted") throw new AppError("storage_error", "素材的持久化对象不存在。", 404);
      objects.push(stored);
      totalMs += durationMs;
    }
    if (totalMs < 3000) throw new AppError("invalid_request", "短视频组合时长不足 3 秒。", 400);
    const clipped = await prepareVideoClip(objects.map(item => `${item.id}:${item.updatedAt.getTime()}`).join(","),
      clipMs === null ? totalMs : Number(clipMs), destination => downloadMediaObject(objects[0], destination), false,
      objects.slice(1).map(item => destination => downloadMediaObject(item, destination)));
    return localMediaResponse({ mimeType: "video/mp4", filename: `${asset.id}-concat.mp4` }, clipped!, request);
  }
  const stillImage = asset.mediaType === "image" && params.has("still_ms");
  if (stillImage && params.get("still_ms") !== "3000") {
    throw new AppError("invalid_request", "静态图片视频时长固定为 3000 毫秒。", 400);
  }
  if (stillImage || (clipMs !== null && asset.mediaType === "video")) {
    if (object.status !== "persisted") {
      throw new AppError("storage_error", "素材的持久化对象不存在。", 404);
    }
    const clipped = await prepareVideoClip(`${object.id}:${object.updatedAt.getTime()}`, stillImage ? 3000 : Number(clipMs),
      destination => downloadMediaObject(object, destination), stillImage);
    if (clipped) {
      return localMediaResponse({ mimeType: "video/mp4", filename: `${asset.id}-clip.mp4` }, clipped, request);
    }
  }
  return mediaObjectResponse(
    object,
    { mimeType: asset.mimeType, filename: asset.originalFilename },
    request,
  );
}

/** 返回素材缩略图：视频子素材首帧，图片则直接使用原媒体。 */
export async function thumbnailResponse(
  assetId: string,
  request: Request,
  storage?: ObjectStorage,
) {
  const row = await getAssetThumbnailObject(assetId);
  if (!row || row.asset.deletedAt || row.asset.reviewStatus === "deleted") {
    throw new AppError("invalid_request", "缩略图不存在。", 404);
  }
  if (!mediaIsReady(row.asset)) {
    throw new AppError(
      "invalid_request",
      "素材完成媒体校验后才可读取缩略图。",
      409,
    );
  }
  // 图片使用原文件名；视频使用 thumbnail 后缀
  const isImage = row.asset.mediaType === "image";
  const filename = isImage
    ? row.asset.originalFilename
    : `${row.asset.id}-thumbnail.jpg`;
  const mimeType = isImage ? row.asset.mimeType : row.object.mimeType;

  return mediaObjectResponse(
    row.object,
    { mimeType, filename },
    request,
    storage,
  );
}
