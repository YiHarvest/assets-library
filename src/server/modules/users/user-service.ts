import { apiV1Path } from "@/lib/paths";
import { ApiV1Error } from "@/server/api/errors";
import type * as AssetRepository from "@/server/repositories/assets";
import type { UserMediaCursor } from "@/server/repositories/assets";
import type {
  UserMediaListQuery,
  UserMediaListResponse,
  UserStorageUsageResponse,
} from "@/shared/contracts";

type UserRepository = Pick<
  typeof AssetRepository,
  "listRegisteredUsers" | "listUserMediaPage" | "summarizeUserStorage"
>;

function directMediaUrl(
  origin: string,
  assetId: string,
  userId: string,
  variant: "media" | "thumbnail",
) {
  const suffix = variant === "thumbnail" ? "/thumbnail" : "";
  const url = new URL(apiV1Path(`/media/${assetId}${suffix}`), origin);
  url.searchParams.set("user_id", userId);
  return url.toString();
}

function shanghaiIso(value: Date | null) {
  if (!value) return null;
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

/** 用户媒体游标编码 UTC 时间和 UUID，避免新增数据导致 OFFSET 翻页漂移。 */
export function encodeUserMediaCursor(cursor: UserMediaCursor) {
  return Buffer.from(
    JSON.stringify({
      created_at: cursor.createdAt.toISOString(),
      asset_id: cursor.assetId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeUserMediaCursor(
  cursor: string | null,
): UserMediaCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { created_at?: unknown; asset_id?: unknown };
    if (
      typeof value.created_at !== "string" ||
      typeof value.asset_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.asset_id,
      )
    ) {
      throw new Error("invalid cursor payload");
    }
    const createdAt = new Date(value.created_at);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== value.created_at
    ) {
      throw new Error("invalid cursor timestamp");
    }
    return { createdAt, assetId: value.asset_id };
  } catch {
    throw new ApiV1Error("invalid_request", "cursor 无效或已经过期。", 400);
  }
}

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  /** 列出 users 注册表中的用户资料及当前有效素材数（MCP list_users 用）。 */
  async listUsers() {
    return this.repository.listRegisteredUsers().then((rows) =>
      rows.map((row) => ({
        user_id: row.userId,
        display_name: row.displayName,
        email: row.email,
        department: row.department,
        first_seen_at: shanghaiIso(row.firstSeenAt)!,
        last_seen_at: shanghaiIso(row.lastSeenAt)!,
        asset_count: row.assetCount,
      })),
    );
  }

  async getUserStorageUsage(
    userId: string,
  ): Promise<UserStorageUsageResponse> {
    const summary = await this.repository.summarizeUserStorage(userId);
    const imageFiles = summary.items.filter(
      (item) => item.mediaType === "image",
    ).length;
    return {
      user_id: summary.userId,
      total_files: summary.totalFiles,
      image_files: imageFiles,
      video_files: summary.totalFiles - imageFiles,
      total_bytes: summary.totalBytes,
      image_bytes: summary.imageBytes,
      video_bytes: summary.videoBytes,
      items: summary.items.map((item) => ({
        asset_id: item.assetId,
        name: item.name,
        media_type: item.mediaType,
        media_bytes: item.mediaBytes,
        thumbnail_bytes: item.thumbnailBytes,
        total_bytes: item.totalBytes,
      })),
    };
  }

  async listUserMedia(
    userId: string,
    input: UserMediaListQuery,
    origin: string,
  ): Promise<UserMediaListResponse> {
    const result = await this.repository.listUserMediaPage(
      userId,
      decodeUserMediaCursor(input.cursor),
      input.limit,
    );
    return {
      user_id: userId,
      items: result.items.map((item) => {
        const media_url = directMediaUrl(
          origin,
          item.assetId,
          userId,
          "media",
        );
        const common = {
          asset_id: item.assetId,
          name: item.name,
          size_bytes: item.sizeBytes,
          media_url,
          created_at: shanghaiIso(item.createdAt)!,
        };
        if (item.mediaType === "image") {
          return { ...common, media_type: "image" as const };
        }
        return {
          ...common,
          media_type: "video" as const,
          thumbnail_bytes: item.thumbnailBytes,
          thumbnail_url: directMediaUrl(
            origin,
            item.assetId,
            userId,
            "thumbnail",
          ),
        };
      }),
      next_cursor: result.nextCursor
        ? encodeUserMediaCursor(result.nextCursor)
        : null,
      has_more: result.hasMore,
    };
  }
}
