import { describe, expect, it } from "vitest";
import {
  assetEditSchema,
  descriptionSearchSchema,
  imageAnalysisSchema,
  mediaTypeSchema,
  userDirectoryResponseSchema,
  userMediaListResponseSchema,
  userStorageUsageResponseSchema,
  videoAnalysisSchema,
} from "@/shared/contracts";

describe("shared contracts", () => {
  it("accepts a complete image analysis", () => {
    expect(
      imageAnalysisSchema.parse({
        kind: "image",
        description: "城市夜景",
        tags: {
          scene: ["城市"],
          object: ["建筑"],
          person: [],
          style: ["纪实"],
          color_composition: ["冷色调"],
        },
        ocr: { text: null, unavailableReason: "没有文字" },
      }),
    ).toBeTruthy();
  });

  it("rejects audio and malformed video timestamps", () => {
    expect(() => mediaTypeSchema.parse("audio")).toThrow();
    expect(() =>
      videoAnalysisSchema.parse({
        kind: "video",
        description: "测试",
        topics: [],
        tags: { scene: [], person: [], form: [] },
        visualSegments: [{ startSeconds: -1, endSeconds: 2, summary: "错误" }],
        keyMoments: [],
        timeline: [],
      }),
    ).toThrow();
  });

  it("trims and validates editable metadata", () => {
    const edit = assetEditSchema.parse({
      name: "  海报  ",
      description: "描述",
      tags: [{ category: "scene", value: " 室内 " }],
    });
    expect(edit.name).toBe("海报");
    expect(edit.tags[0]?.value).toBe("室内");
  });

  it("defaults and bounds description search requests", () => {
    expect(
      descriptionSearchSchema.parse({
        description: "  白色背景下的柑橘产品图  ",
        keywords: ["  白色 ", "橙子"],
      }),
    ).toEqual({
      description: "白色背景下的柑橘产品图",
      keywords: ["白色", "橙子"],
      limit: 5,
    });
    expect(() => descriptionSearchSchema.parse({ description: "x", limit: 21 })).toThrow();
  });

  it("validates user storage totals and discriminated media links", () => {
    expect(
      userStorageUsageResponseSchema.parse({
        user_id: "user-7",
        total_files: 1,
        image_files: 0,
        video_files: 1,
        total_bytes: 15,
        image_bytes: 0,
        video_bytes: 15,
        items: [
          {
            asset_id: "00000000-0000-4000-8000-000000000003",
            name: "clip",
            media_type: "video",
            media_bytes: 12,
            thumbnail_bytes: 3,
            total_bytes: 15,
          },
        ],
      }),
    ).toBeTruthy();
    expect(() =>
      userMediaListResponseSchema.parse({
        user_id: "user-7",
        items: [
          {
            asset_id: "00000000-0000-4000-8000-000000000003",
            name: "clip",
            media_type: "video",
            size_bytes: 12,
            media_url: "https://example.test/video",
            created_at: "2026-08-12T12:00:00+08:00",
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    ).toThrow(/thumbnail/);
  });

  it("validates the WebUI user directory", () => {
    expect(
      userDirectoryResponseSchema.parse({
        items: [
          {
            user_id: "user-7",
            display_name: "剪辑用户",
            email: "editor@example.com",
            department: "内容中心",
            first_seen_at: "2026-08-12T12:00:00+08:00",
            last_seen_at: "2026-08-13T12:00:00+08:00",
            asset_count: 3,
          },
        ],
      }),
    ).toBeTruthy();
    expect(() =>
      userDirectoryResponseSchema.parse({
        items: [{ user_id: "", asset_count: -1 }],
      }),
    ).toThrow();
  });
});
