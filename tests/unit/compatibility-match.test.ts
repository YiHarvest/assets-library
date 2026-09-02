import { describe, expect, it, vi } from "vitest";
import {
  alignCompatibilitySegments,
  compatibilityCallbackFromJob,
  matchCompatibilitySegments,
} from "@/server/services/compatibility-match";
import {
  compatibilityMatchRequestSchema,
  type AssetSummary,
} from "@/shared/contracts";

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

  it("returns an absolute matched asset URL with its normalized score", async () => {
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
    );
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

  it("returns explicit null candidate fields and below-threshold diagnostics", async () => {
    const segment = alignCompatibilitySegments(request())[0]!;
    const [unmatched] = await matchCompatibilitySegments(
      [segment],
      "https://focus.example.test",
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
