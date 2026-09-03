import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { assetEntries, mediaObjects } from "@/server/db/schema";

const thumbnailAssetSelection = {
  id: assetEntries.id,
  mediaType: assetEntries.mediaType,
  originalFilename: assetEntries.originalFilename,
  mimeType: assetEntries.mimeType,
  processingStatus: assetEntries.processingStatus,
  reviewStatus: assetEntries.reviewStatus,
  failureCode: assetEntries.failureCode,
  deletedAt: assetEntries.deletedAt,
};

/**
 * 读取一个素材的缩略图对象。
 * - 视频：使用 thumbnailMediaObjectId（抽取的首帧）
 * - 图片：回退到 mediaObjectId（原图本身）
 * 权限作用域仍由 API service 在调用前校验。
 */
export async function getAssetThumbnailObject(assetId: string) {
  // 先尝试视频缩略图（thumbnailMediaObjectId）
  const [videoRow] = await db
    .select({ asset: thumbnailAssetSelection, object: mediaObjects })
    .from(assetEntries)
    .innerJoin(
      mediaObjects,
      eq(mediaObjects.id, assetEntries.thumbnailMediaObjectId),
    )
    .where(
      and(
        eq(assetEntries.id, assetId),
        eq(assetEntries.mediaType, "video"),
        eq(mediaObjects.status, "persisted"),
      ),
    )
    .limit(1);
  if (videoRow) return videoRow;

  // 回退：图片缩略图直接使用原图（mediaObjectId）
  const [imageRow] = await db
    .select({ asset: thumbnailAssetSelection, object: mediaObjects })
    .from(assetEntries)
    .innerJoin(
      mediaObjects,
      eq(mediaObjects.id, assetEntries.mediaObjectId),
    )
    .where(
      and(
        eq(assetEntries.id, assetId),
        eq(assetEntries.mediaType, "image"),
        eq(mediaObjects.status, "persisted"),
      ),
    )
    .limit(1);
  return imageRow ?? null;
}
