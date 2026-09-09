import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alignCompatibilitySegments,
  compatibilityCallbackFromJob,
  compatibilityCallbackFields,
  matchCompatibilitySegments,
} from "@/server/services/compatibility-match";
import {
  compatibilityMatchRequestSchema,
  type AssetSummary,
} from "@/shared/contracts";
import { searchAssetsByDescriptionDetailed } from "@/server/repositories/assets";
import * as elasticsearch from "@/server/search/elasticsearch";
import { loadTestConfig } from "../helpers/config";

const databaseRows = vi.hoisted(() => vi.fn());
vi.mock("@/server/db", () => ({
  db: { select: () => ({ from: () => ({ where: databaseRows }) }) },
}));

function request() {
  return compatibilityMatchRequestSchema.parse({
    asr: {
      file_url: "https://media.example.test/source.mp4",
      transcripts: [
        {
          sentences: [
            {
              text: "如果能回到二十岁。",
              sentence_id: 1,
              words: [
                { text: "如果能", begin_time: 320, end_time: 800 },
                { text: "回到", begin_time: 800, end_time: 1_200 },
                {
                  text: "二十岁",
                  begin_time: 1_200,
                  end_time: 1_600,
                  punctuation: "。",
                },
              ],
            },
            {
              text: "我想对自己说。",
              sentence_id: 2,
              words: [
                { text: "我想", begin_time: 1_920, end_time: 2_200 },
                { text: "对自己说", begin_time: 2_200, end_time: 2_840 },
              ],
            },
          ],
        },
      ],
    },
    llm: JSON.stringify({
      segments: [
        {
          segment_id: 1,
          text: "如果能回到",
          high_light_word: "回到",
          level: 2,
          render_hint: "hero",
        },
        {
          segment_id: 2,
          text: "二十岁！",
          high_light_word: "",
          level: 1,
        },
        {
          segment_id: 3,
          text: "我想对自己说",
          keyword: "自己",
          level: 3,
        },
      ],
    }),
    text: "如果能回到二十岁。我想对自己说。",
    asset_url_list: [],
    callback_url: "https://callback.example.test/match",
    business_id: "biz-1",
  });
}

function candidate(): AssetSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "夕阳剪影",
    description: "夕阳下女性剪影，符合回忆意境",
    mediaType: "video",
    processingStatus: "completed",
    reviewStatus: "published",
    tags: [],
    mediaUrl:
      "/api/v1/media/00000000-0000-4000-8000-000000000001?v=1",
    createdAt: "2026-09-02T08:00:00.000Z",
    searchScore: 0.91,
    semanticScore: 0.91,
  };
}

describe("compatibility segment matching", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("enables clipping by default and accepts an explicit opt-out", () => {
    expect(loadTestConfig({}).SEGMENT_MATCH_CLIP_ENABLED).toBe(true);
    expect(loadTestConfig({ SEGMENT_MATCH_CLIP_ENABLED: "false" }).SEGMENT_MATCH_CLIP_ENABLED).toBe(false);
    expect(() => loadTestConfig({ SEGMENT_MATCH_CLIP_ENABLED: "invalid" })).toThrow();
  });

  it.each([
    { enabled: "true", mediaType: "video" as const, sourceMs: 8500, clip: "1480" },
    { enabled: "false", mediaType: "video" as const, sourceMs: 8500, clip: null },
    { enabled: "true", mediaType: "video" as const, sourceMs: 1000, clip: null },
    { enabled: "true", mediaType: "video" as const, sourceMs: 1480, clip: null },
    { enabled: "true", mediaType: "image" as const, sourceMs: 8500, clip: null },
  ])("returns a playable URL without changing the timeline: $enabled / $mediaType / $sourceMs", async ({ enabled, mediaType, sourceMs, clip }) => {
    vi.stubEnv("SEGMENT_MATCH_CLIP_ENABLED", enabled);
    const segment = { ...alignCompatibilitySegments(request())[0], start_time: 6.12, end_time: 7.6 };
    const search = vi.fn<typeof searchAssetsByDescriptionDetailed>(async () => ({
      items: [{ ...candidate(), mediaType }], threshold: 0, maxScore: 0.5,
      reason: "matched" as const, message: null,
    }));
    const [matched] = await matchCompatibilitySegments([segment], "https://focus.example.test", {
      assetUrls: [new URL(candidate().mediaUrl, "https://focus.example.test").toString()],
    }, {
      search,
      getAsset: async () => ({ userId: "759", reviewStatus: "published", segmentStartMs: 5000, segmentEndMs: 5000 + sourceMs }),
    });
    expect(matched).toMatchObject(segment);
    const url = new URL(matched.matched_candidate_url!);
    expect(url.pathname).toBe(`/api/v1/media/${candidate().id}`);
    expect(url.searchParams.get("user_id")).toBe("759");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("clip_ms")).toBe(clip);
    expect(search.mock.calls[0][2]).not.toHaveProperty("minDurationMs");
  });

  it("passes existing sentence context to recall while preserving segment text, timing and selection scope", async () => {
    const base = alignCompatibilitySegments(request())[0];
    const segments = [
      { ...base, segment_id: 1, text: "目前只有安卓手机", group_id: [1, 1] as [number, number] },
      { ...base, segment_id: 2, text: "店关着门它也在干活", group_id: [1, 1] as [number, number] },
    ];
    const search = vi.fn(async () => ({ items: [], threshold: 0, maxScore: null, reason: "no_candidates" as const, message: null }));
    const result = await matchCompatibilitySegments(segments, "https://focus.example.test", { isRandom: false }, {
      search, getAsset: async () => null,
    });
    expect(search).toHaveBeenLastCalledWith(
      { description: "店关着门它也在干活", keywords: [], limit: 100 }, { includeAllUsers: true },
      expect.objectContaining({ context: "目前只有安卓手机，店关着门它也在干活", excludedAssetIds: [], isRandom: false }),
    );
    result.forEach((segment, index) => expect(segment).toMatchObject(segments[index]));
    expect(result[1]).not.toHaveProperty("context");
  });

  it("defaults and validates semantic selection controls", () => {
    const parsed = request();
    expect(parsed).toMatchObject({
      is_random: true,
      semantic_threshold: 0.3,
    });

    expect(
      compatibilityMatchRequestSchema.parse({
        ...parsed,
        is_random: false,
        semantic_threshold: 0,
      }),
    ).toMatchObject({ is_random: false, semantic_threshold: 0 });
    expect(
      compatibilityMatchRequestSchema.parse({
        ...parsed,
        semantic_threshold: 1,
      }).semantic_threshold,
    ).toBe(1);
    expect(() =>
      compatibilityMatchRequestSchema.parse({
        ...parsed,
        semantic_threshold: -0.01,
      }),
    ).toThrow();
    expect(() =>
      compatibilityMatchRequestSchema.parse({
        ...parsed,
        semantic_threshold: 1.01,
      }),
    ).toThrow();
    expect(() =>
      compatibilityMatchRequestSchema.parse({
        ...parsed,
        is_random: "true",
      }),
    ).toThrow();
  });

  it("does not copy matching controls into callback passthrough fields", () => {
    expect(compatibilityCallbackFields(request())).toEqual({
      business_id: "biz-1",
    });
  });

  it("parses the stringified LLM payload and aligns segment times and groups", () => {
    const parsed = request();
    expect(parsed.llm.segments).toHaveLength(3);
    expect(parsed.business_id).toBe("biz-1");

    expect(alignCompatibilitySegments(parsed)).toEqual([
      expect.objectContaining({
        segment_id: 1,
        keyword: "回到",
        group_id: [1, 2],
        start_time: 0.32,
        end_time: 1.2,
        render_hint: "hero",
      }),
      expect.objectContaining({
        segment_id: 2,
        keyword: "",
        group_id: [2, 2],
        start_time: 1.2,
        end_time: 1.6,
      }),
      expect.objectContaining({
        segment_id: 3,
        keyword: "自己",
        group_id: [1, 1],
        start_time: 1.92,
        end_time: 2.84,
      }),
    ]);
  });

  it("rejects an LLM segment that cannot be aligned in ASR order", () => {
    const parsed = request();
    parsed.llm.segments[1]!.text = "完全不存在的内容";
    expect(() => alignCompatibilitySegments(parsed)).toThrow(/无法按顺序对齐/);
  });

  it("accepts pre-aligned LLM segments when ASR is an empty object", () => {
    const parsed = compatibilityMatchRequestSchema.parse({
      callback_url: "https://callback.example.test/match",
      asr: {},
      text: "做过生意的人都明白",
      llm: {
        segments: [
          {
            segment_id: 1,
            text: "做过生意的人都明白",
            keyword: "生意",
            level: 1,
            group_id: [1, 4],
            start_time: 0.28,
            end_time: 1.56,
          },
        ],
      },
      asset_url_list: [
        {
          file_url: "https://media.example.test/source.mp4",
          type: "video",
        },
      ],
    });

    expect(alignCompatibilitySegments(parsed)).toEqual([
      expect.objectContaining({
        segment_id: 1,
        keyword: "生意",
        group_id: [1, 4],
        start_time: 0.28,
        end_time: 1.56,
      }),
    ]);
  });

  it.each(["published", "pending_review", "deleted"])("checks %s before returning a matched asset URL", async (reviewStatus) => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const search = vi.fn(async () => ({
      items: [candidate()],
      threshold: 0.55,
      maxScore: 0.91,
      reason: "matched" as const,
      message: null,
    }));

    const [matched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
      { isRandom: false, semanticThreshold: 0.55 },
      {
        search,
        getAsset: async () => ({
          userId: "759",
          reviewStatus,
        }),
      },
    );

    expect(search).toHaveBeenCalledWith(
      { description: segment.text, keywords: [], limit: 100 },
      { includeAllUsers: true },
      {
        semanticThreshold: 0.55,
        isRandom: false,
        excludedAssetIds: [],
      },
    );
    if (reviewStatus === "deleted") {
      expect(matched).toMatchObject({
        matched_candidate_url: null,
        matched_candidate_reason: "no_candidates",
      });
      return;
    }
    expect(matched).toMatchObject({
      matched_candidate_url:
        "https://focus.example.test/api/v1/media/00000000-0000-4000-8000-000000000001?v=1&user_id=759",
      matched_candidate_type: "video",
      matched_candidate_desc: "夕阳下女性剪影，符合回忆意境",
      matched_candidate_score: 0.91,
      matched_candidate_reason: null,
      matched_candidate_message: null,
    });
  });

  it.each([true, false])("assigns distinct assets from full candidate pools with isRandom=%s", async (isRandom) => {
    const segments = alignCompatibilitySegments(request());
    const secondCandidate: AssetSummary = {
      ...candidate(),
      id: "00000000-0000-4000-8000-000000000002",
      name: "城市夜景",
      description: "城市夜景中的车流",
      mediaUrl:
        "/api/v1/media/00000000-0000-4000-8000-000000000002?v=1",
      searchScore: 0.72,
      semanticScore: 0.72,
    };
    const search = vi.fn<typeof searchAssetsByDescriptionDetailed>(async (_input, _scope, options) => {
      const available = [candidate(), secondCandidate].filter(
        (item) => !options?.excludedAssetIds?.includes(item.id),
      );
      return {
        items: available,
        threshold: 0.3,
        maxScore: available[0]?.semanticScore ?? null,
        reason: available.length ? "matched" : "no_candidates",
        message: null,
      };
    });

    const matched = await matchCompatibilitySegments(
      segments,
      "https://focus.example.test",
      { isRandom, semanticThreshold: 0.3 },
      {
        search,
        getAsset: async () => ({
          userId: null,
          reviewStatus: "published",
        }),
      },
    );

    expect(matched.flatMap(segment => segment.matched_candidate_url ? [segment.matched_candidate_url] : []).sort()).toEqual([
      "https://focus.example.test/api/v1/media/00000000-0000-4000-8000-000000000001?v=1",
      "https://focus.example.test/api/v1/media/00000000-0000-4000-8000-000000000002?v=1",
    ]);
    expect(matched.map((segment) => segment.segment_id)).toEqual([1, 2, 3]);
    expect(matched.find(segment => !segment.matched_candidate_url)?.matched_candidate_reason).toBe("no_candidates");
  });

  it("excludes used assets before vector recall and stops when none remain", async () => {
    databaseRows.mockResolvedValueOnce([{ id: "asset-b" }]).mockResolvedValue([]);
    const search = vi.spyOn(elasticsearch, "searchAssets").mockResolvedValue([]);
    try {
      await searchAssetsByDescriptionDetailed(
        { description: "夕阳", keywords: [], limit: 1 },
        { includeAllUsers: true },
        { excludedAssetIds: ["asset-a"] },
      );
      expect(search).toHaveBeenCalledWith("夕阳", ["asset-b"], undefined, undefined);
      const exhausted = await searchAssetsByDescriptionDetailed(
        { description: "夕阳", keywords: [], limit: 1 },
        { includeAllUsers: true },
        { excludedAssetIds: ["asset-a", "asset-b"] },
      );
      expect(exhausted).toMatchObject({ items: [], reason: "no_candidates" });
      expect(search).toHaveBeenLastCalledWith("夕阳", [], undefined, undefined);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([true, false])("rejects repeated candidates even if search ignores exclusions with isRandom=%s", async (isRandom) => {
    const segments = alignCompatibilitySegments(request()).slice(0, 2);
    const matched = await matchCompatibilitySegments(
      segments,
      "https://focus.example.test",
      { isRandom, semanticThreshold: 0.55 },
      {
        search: async () => ({
          items: [candidate()],
          threshold: 0.55,
          maxScore: 0.91,
          reason: "matched",
          message: null,
        }),
        getAsset: async () => ({
          userId: "759",
          reviewStatus: "published",
        }),
      },
    );

    expect(matched.map((segment) => segment.matched_candidate_url)).toEqual([
      "https://focus.example.test/api/v1/media/00000000-0000-4000-8000-000000000001?v=1&user_id=759",
      null,
    ]);
    expect(matched[1]).toMatchObject({
      matched_candidate_type: null,
      matched_candidate_desc: null,
      matched_candidate_score: 0.91,
      matched_candidate_reason: "no_candidates",
      matched_candidate_message: "没有可用的匹配素材。",
    });
  });

  it("returns explicit null candidate fields and below-threshold diagnostics", async () => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const [unmatched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
      { isRandom: false, semanticThreshold: 0.55 },
      {
        search: async () => ({
          items: [],
          threshold: 0.55,
          maxScore: 0.54,
          reason: "below_threshold",
          message: "最高匹配分为 0.540，未超过展示阈值 0.550。",
        }),
        getAsset: async () => null,
      },
    );

    expect(unmatched).toMatchObject({
      matched_candidate_url: null,
      matched_candidate_type: null,
      matched_candidate_desc: null,
      matched_candidate_score: 0.54,
      matched_candidate_reason: "below_threshold",
      matched_candidate_message:
        "最高匹配分为 0.540，未超过展示阈值 0.550。",
    });
  });

  it("explains when semantic matching is unavailable", async () => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const [unmatched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
      { isRandom: false, semanticThreshold: 0.55 },
      {
        search: async () => ({
          items: [],
          threshold: 0.55,
          maxScore: null,
          reason: "semantic_unavailable",
          message: "语义搜索暂不可用，请稍后重试。",
        }),
        getAsset: async () => null,
      },
    );

    expect(unmatched).toMatchObject({
      matched_candidate_url: null,
      matched_candidate_type: null,
      matched_candidate_desc: null,
      matched_candidate_score: null,
      matched_candidate_reason: "semantic_unavailable",
      matched_candidate_message: "语义搜索暂不可用，请稍后重试。",
    });
  });

  it("restricts semantic matching to asset_url_list when it is non-empty", async () => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const search = vi.fn(async () => ({
      items: [candidate()],
      threshold: 0.55,
      maxScore: 0.91,
      reason: "matched" as const,
      message: null,
    }));
    const selectedUrl =
      "https://focus.example.test/api/v1/media/00000000-0000-4000-8000-000000000001?v=2&user_id=759";

    const [matched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
      {
        assetUrls: [
          selectedUrl,
          { file_url: selectedUrl, type: "video" },
        ],
        isRandom: false,
        semanticThreshold: 0.55,
      },
      {
        search,
        getAsset: async () => ({
          userId: "759",
          reviewStatus: "published",
        }),
      },
    );

    expect(search).toHaveBeenCalledWith(
      { description: segment.text, keywords: [], limit: 1 },
      { includeAllUsers: true },
      {
        candidateAssetIds: ["00000000-0000-4000-8000-000000000001"],
        excludedAssetIds: [],
        semanticThreshold: 0.55,
        isRandom: false,
      },
    );
    expect(matched.matched_candidate_url).toContain(
      "/api/v1/media/00000000-0000-4000-8000-000000000001",
    );
  });

  it("does not fall back to the full library for non-library asset URLs", async () => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const search = vi.fn();

    const [unmatched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
      {
        assetUrls: ["https://media.example.test/source.mp4"],
        isRandom: false,
        semanticThreshold: 0.55,
      },
      {
        search,
        getAsset: async () => null,
      },
    );

    expect(search).not.toHaveBeenCalled();
    expect(unmatched).toMatchObject({
      matched_candidate_url: null,
      matched_candidate_reason: "no_candidates",
      matched_candidate_message: "asset_url_list 中没有可识别的素材库 URL。",
    });
  });

  it("uses a custom callback body only for compatibility callback jobs", () => {
    const body = {
      business_id: "biz-1",
      taskId: crypto.randomUUID(),
      status: "success",
      result: { segments: [] },
    };
    expect(
      compatibilityCallbackFromJob({
        id: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        assetId: null,
        type: "callback",
        attempt: 1,
        payload: { compatibilityCallback: body },
      }),
    ).toEqual(body);
  });
});
