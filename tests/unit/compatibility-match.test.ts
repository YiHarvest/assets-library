import { describe, expect, it } from "vitest";
import {
  alignCompatibilitySegments,
  compatibilityCallbackFromJob,
} from "@/server/services/compatibility-match";
import { compatibilityMatchRequestSchema } from "@/shared/contracts";

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
