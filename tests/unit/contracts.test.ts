import { describe, expect, it } from "vitest";
import {
  apiV1AssetSummarySchema,
  assetEditSchema,
  assetQueryResponseSchema,
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

  it("validates normalized search scores and search metadata", () => {
    const asset = {
      asset_id: "00000000-0000-4000-8000-000000000001",
      parent_video_id: null,
      segment_index: null,
      user_id: null,
      name: "AI 发布会",
      description: "人工智能产品发布会现场",
      media_type: "image",
      status: "done",
      review_status: "published",
      tags: [{ category: "style", value: "科技感" }],
      media_url: "/api/v1/media/00000000-0000-4000-8000-000000000001",
      created_at: "2026-08-12T12:00:00+08:00",
      updated_at: "2026-08-12T12:00:00+08:00",
      search_score: 0.86,
      keyword_score: 1,
      semantic_score: 0.767,
      match_type: "hybrid",
      matched_terms: ["ai"],
      matched_categories: ["style"],
    };
    expect(
      assetQueryResponseSchema.parse({
        items: [asset],
        next_cursor: null,
        has_more: false,
        tag_statistics: null,
        search: {
          mode: "hybrid",
          threshold: 0.65,
          max_score: 0.86,
          reason: "matched",
          message: null,
        },
      }),
    ).toBeTruthy();
    expect(() =>
      apiV1AssetSummarySchema.parse({ ...asset, search_score: 1.01 }),
    ).toThrow();
  });

  it("requires a message-bearing search outcome for filtered empty results", () => {
    const emptyResult = {
      items: [],
      next_cursor: null,
      has_more: false,
      tag_statistics: null,
      search: {
        mode: "semantic",
        threshold: 0.55,
        max_score: 0.49,
        reason: "below_threshold",
        message: "最高匹配分低于展示阈值。",
      },
    };
    expect(assetQueryResponseSchema.parse(emptyResult)).toEqual(emptyResult);
    expect(() =>
      assetQueryResponseSchema.parse({
        ...emptyResult,
        search: { ...emptyResult.search, message: undefined },
      }),
    ).toThrow();
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
