import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "@/server/db";
import { assets, mediaObjects } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import type { MediaType } from "@/shared/contracts";

const mainMediaObjects = alias(mediaObjects, "published_main_media_objects");
const thumbnailMediaObjects = alias(
  mediaObjects,
  "published_thumbnail_media_objects",
);

export interface PublishedMediaCursor {
  createdAt: Date;
  assetId: string;
}

function normalizeUserId(userId: string | null) {
  if (userId === null) return null;
  const normalized = userId.trim();
  if (!normalized) return null;
  if (normalized.length > 191) {
    throw new AppError("invalid_request", "user_id 不得超过 191 个字符。", 400);
  }
  return normalized;
}

function ownerCondition(userId: string | null) {
  return userId === null
    ? isNull(assets.userId)
    : sql<boolean>`BINARY ${assets.userId} = BINARY ${userId}`;
}

/**
 * 对外列表和用量统计共享同一可见边界：已发布、主对象已落 ZOS；视频还必须
 * 具有已持久化首帧。这样返回的每条直链都可以立即使用。
 */
function publishedPersistedConditions(userId: string | null) {
  return and(
    ownerCondition(userId),
    eq(assets.reviewStatus, "published"),
    eq(mainMediaObjects.provider, "zos"),
    eq(mainMediaObjects.status, "persisted"),
    or(
      eq(assets.mediaType, "image"),
      and(
        eq(assets.mediaType, "video"),
        eq(thumbnailMediaObjects.provider, "zos"),
        eq(thumbnailMediaObjects.status, "persisted"),
      ),
    ),
  );
}

const mediaBytes = sql<number>`coalesce(${mainMediaObjects.sizeBytes}, 0)`;
const thumbnailBytes = sql<number>`case when ${assets.mediaType} = 'video' then coalesce(${thumbnailMediaObjects.sizeBytes}, 0) else 0 end`;
const totalBytes = sql<number>`(${mediaBytes} + ${thumbnailBytes})`;

export interface PublishedMediaItem {
  assetId: string;
  name: string;
  mediaType: MediaType;
  mediaBytes: number;
  thumbnailBytes: number;
  createdAt: Date;
}

/** 稳定 keyset 分页列出某个用户或公共库中可直接访问的素材。 */
export async function listPublishedMedia(
  rawUserId: string | null,
  cursor: PublishedMediaCursor | null,
  limit: number,
) {
  const userId = normalizeUserId(rawUserId);
  const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 20, 1), 100);
  const cursorCondition = cursor
    ? or(
        lt(assets.createdAt, cursor.createdAt),
        and(eq(assets.createdAt, cursor.createdAt), lt(assets.id, cursor.assetId)),
      )
    : undefined;
  const rows = await db
    .select({
      assetId: assets.id,
      name: assets.name,
      mediaType: assets.mediaType,
      mediaBytes: mediaBytes.mapWith(Number),
      thumbnailBytes: thumbnailBytes.mapWith(Number),
      createdAt: assets.createdAt,
    })
    .from(assets)
    .innerJoin(
      mainMediaObjects,
      eq(assets.mediaObjectId, mainMediaObjects.id),
    )
    .leftJoin(
      thumbnailMediaObjects,
      eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
    )
    .where(and(publishedPersistedConditions(userId), cursorCondition))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(safeLimit + 1);
  const hasMore = rows.length > safeLimit;
  const items = (hasMore ? rows.slice(0, safeLimit) : rows) satisfies PublishedMediaItem[];
  const last = items.at(-1);
  return {
    userId,
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? { createdAt: last.createdAt, assetId: last.assetId }
        : null,
  };
}

/** 使用 SQL 一次汇总，再返回同一计费边界下的逐素材明细。 */
export async function summarizePublishedStorage(rawUserId: string | null) {
  const userId = normalizeUserId(rawUserId);
  const conditions = publishedPersistedConditions(userId);
  return db.transaction(async (tx) => {
    const base = tx
      .select({
        assetId: assets.id,
        name: assets.name,
        mediaType: assets.mediaType,
        mediaBytes: mediaBytes.mapWith(Number),
        thumbnailBytes: thumbnailBytes.mapWith(Number),
        totalBytes: totalBytes.mapWith(Number),
      })
      .from(assets)
      .innerJoin(mainMediaObjects, eq(assets.mediaObjectId, mainMediaObjects.id))
      .leftJoin(
        thumbnailMediaObjects,
        eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
      )
      .where(conditions);
    const [totals] = await tx
      .select({
        totalFiles: sql<number>`count(*)`.mapWith(Number),
        imageFiles:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'image' then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        videoFiles:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'video' then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        imageBytes:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'image' then ${totalBytes} else 0 end), 0)`.mapWith(
            Number,
          ),
        videoBytes:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'video' then ${totalBytes} else 0 end), 0)`.mapWith(
            Number,
          ),
        totalBytes: sql<number>`coalesce(sum(${totalBytes}), 0)`.mapWith(Number),
      })
      .from(assets)
      .innerJoin(mainMediaObjects, eq(assets.mediaObjectId, mainMediaObjects.id))
      .leftJoin(
        thumbnailMediaObjects,
        eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
      )
      .where(conditions);
    return {
      userId,
      totalFiles: totals?.totalFiles ?? 0,
      imageFiles: totals?.imageFiles ?? 0,
      videoFiles: totals?.videoFiles ?? 0,
      imageBytes: totals?.imageBytes ?? 0,
      videoBytes: totals?.videoBytes ?? 0,
      totalBytes: totals?.totalBytes ?? 0,
      items: await base,
    };
  });
}

/** 读取一个素材的缩略图对象；权限作用域仍由 API service 在调用前校验。 */
export async function getAssetThumbnailObject(assetId: string) {
  const [row] = await db
    .select({ asset: assets, object: mediaObjects })
    .from(assets)
    .innerJoin(
      mediaObjects,
      eq(mediaObjects.id, assets.thumbnailMediaObjectId),
    )
    .where(
      and(
        eq(assets.id, assetId),
        eq(assets.mediaType, "video"),
        eq(mediaObjects.status, "persisted"),
      ),
    )
    .limit(1);
  return row ?? null;
}
