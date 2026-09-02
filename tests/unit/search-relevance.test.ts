import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEVANCE_THRESHOLDS,
  categoryWeight,
  classifyTagMatch,
  detectSearchInputMode,
  detectSearchIntent,
  hybridRelevanceScore,
  isBroadAiQuery,
  normalizeSearchText,
  normalizeSemanticText,
  scoreKeywordRelevance,
  selectBroadQueryRecallTier,
  tokenizeKeywordQuery,
} from "@/server/search/relevance";

describe("search relevance", () => {
  it("normalizes width, case, and whitespace with NFKC", () => {
    expect(normalizeSearchText("  ＡＩ   Foo  ")).toBe("ai foo");
    expect(normalizeSemanticText("  夕阳下   一个人  ")).toBe("夕阳下 一个人");
  });

  it("segments keyword queries while preserving business aliases", () => {
    expect(tokenizeKeywordQuery("AI人工智能风格")).toEqual([
      "ai",
      "人工智能",
      "风格",
    ]);
    expect(tokenizeKeywordQuery("AIGC 科技发布会")).toEqual([
      "aigc",
      "科技",
      "发布会",
    ]);
    expect(tokenizeKeywordQuery("城巿")).toEqual(["城巿"]);
    expect(tokenizeKeywordQuery("paid media")).not.toContain("ai");
  });

  it("scores exact, alias, prefix, and contains matches on a zero-to-one scale", () => {
    expect(classifyTagMatch("夜景", "夜景")).toEqual({
      matchType: "exact",
      quality: 1,
    });
    expect(classifyTagMatch("AI", "人工智能")).toEqual({
      matchType: "alias",
      quality: 0.95,
    });
    expect(classifyTagMatch("科技", "科技发布会")).toEqual({
      matchType: "prefix",
      quality: 0.85,
    });
    expect(classifyTagMatch("夜景", "城市夜景航拍")).toEqual({
      matchType: "contains",
      quality: 0.72,
    });
  });

  it("does not broaden short Latin queries", () => {
    expect(classifyTagMatch("ai", "aiframe")).toBeNull();
    expect(classifyTagMatch("ai", "paid")).toBeNull();
    expect(classifyTagMatch("ai", "a1", { allowTypo: true })).toBeNull();
    expect(classifyTagMatch("ai", "ai")?.quality).toBe(1);
  });

  it("enables edit-distance-one typo matching only as an explicit fallback", () => {
    expect(classifyTagMatch("城巿", "城市")).toBeNull();
    expect(classifyTagMatch("城巿", "城市", { allowTypo: true })).toEqual({
      matchType: "typo",
      quality: 0.55,
    });
    expect(classifyTagMatch("tecnology", "technology", { allowTypo: true })).toEqual({
      matchType: "typo",
      quality: 0.55,
    });
    expect(classifyTagMatch("cat", "car", { allowTypo: true })).toBeNull();
    expect(classifyTagMatch("城市", "海边", { allowTypo: true })).toBeNull();
    expect(
      scoreKeywordRelevance(
        "复古风各",
        [{ value: "复古风格", category: "style" }],
        { allowTypo: true },
      ),
    ).toMatchObject({ score: 0.495 });
  });

  it("applies explicit scene and style intent category weights", () => {
    expect(detectSearchIntent("夜晚 场景")).toBe("scene");
    expect(detectSearchIntent("复古 风格")).toBe("style");
    expect(categoryWeight("scene", "scene")).toBe(1);
    expect(categoryWeight("style", "scene")).toBe(0.65);
    expect(categoryWeight("style", "style")).toBe(1);
    expect(categoryWeight("scene", "style")).toBe(0.7);
    expect(categoryWeight("form", "form")).toBe(1);
    expect(categoryWeight("color_composition", "style")).toBe(0.85);
    expect(
      scoreKeywordRelevance("复古 风格", [
        { value: "复古", category: "style" },
      ]),
    ).toMatchObject({ score: 1, matchedTokens: ["复古"] });
  });

  it("normalizes multi-token scores by coverage and reports evidence", () => {
    const result = scoreKeywordRelevance(
      ["城市", "夜景"],
      [
        { value: "城市", category: "scene" },
        { value: "人物", category: "person" },
      ],
    );

    expect(result.score).toBe(0.5);
    expect(result.coverage).toBe(0.5);
    expect(result.matchedTokens).toEqual(["城市"]);
    expect(result.unmatchedTokens).toEqual(["夜景"]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        token: "城市",
        category: "scene",
        matchType: "exact",
        score: 1,
      }),
    ]);
  });

  it("keeps exact evidence eligible when other query tokens do not match", () => {
    for (const query of ["blue 小船", "小船 dsfj"]) {
      expect(
        scoreKeywordRelevance(query, [
          { value: "小船", category: "object" },
        ]),
      ).toMatchObject({
        score: 0.85,
        coverage: 0.5,
        matchedTokens: ["小船"],
      });
    }
  });

  it("recalls contains matches and preserves whole-query typo evidence", () => {
    expect(
      scoreKeywordRelevance("城市", [
        { value: "古城市风光", category: "scene" },
      ]),
    ).toMatchObject({ score: 0.72, matchedTokens: ["城市"] });

    const typo = scoreKeywordRelevance(
      "古城市风光",
      [{ value: "古城巿风光", category: "style" }],
      { allowTypo: true },
    );
    expect(typo).toMatchObject({
      score: 0.495,
      coverage: 1,
      matchedTokens: ["古城市风光"],
      unmatchedTokens: [],
    });
    expect(typo.evidence[0]).toMatchObject({ matchType: "typo" });
  });

  it("chooses the strongest tag evidence for each query token", () => {
    const result = scoreKeywordRelevance("夜景", [
      { value: "城市夜景", category: "scene" },
      { value: "夜景", category: "color_composition" },
    ]);
    expect(result.score).toBe(0.75);
    expect(result.evidence[0]).toMatchObject({
      tag: "夜景",
      matchType: "exact",
      category: "color_composition",
    });
  });

  it("detects broad AI aliases and combines lexical and semantic scores", () => {
    expect(isBroadAiQuery("AI")).toBe(true);
    expect(isBroadAiQuery("人工智能")).toBe(true);
    expect(isBroadAiQuery("AI 发布会")).toBe(false);
    expect(hybridRelevanceScore(1, 0.5)).toBeCloseTo(0.7);
    expect(hybridRelevanceScore(1.8, -1)).toBeCloseTo(0.4);
    expect(hybridRelevanceScore(null, 0.8)).toBe(0.8);
    expect(hybridRelevanceScore(0.9, null)).toBe(0.9);
    expect(hybridRelevanceScore(null, null)).toBe(0);
  });

  it("uses semantic gating for broad AI terms without penalizing exact fallback", () => {
    expect(
      selectBroadQueryRecallTier(
        [
          { assetId: "relevant", lexicalScore: 1, semanticScore: 0.9 },
          { assetId: "irrelevant", lexicalScore: 1, semanticScore: 0.1 },
        ],
        0.55,
      ),
    ).toEqual({ assetIds: ["relevant"], useSemanticRerank: true });

    expect(
      selectBroadQueryRecallTier(
        [
          { assetId: "best-low", lexicalScore: 1, semanticScore: 0.4 },
          { assetId: "second-low", lexicalScore: 1, semanticScore: 0.2 },
          { assetId: "third-low", lexicalScore: 1 },
          { assetId: "suppressed", lexicalScore: 1, semanticScore: 0.1 },
        ],
        0.55,
      ),
    ).toEqual({
      assetIds: ["best-low", "second-low", "suppressed"],
      useSemanticRerank: false,
    });
  });

  it("exports separate defaults for strong, typo, semantic, and hybrid paths", () => {
    expect(DEFAULT_RELEVANCE_THRESHOLDS).toEqual({
      strongKeyword: 0.6,
      typoFallback: 0.4,
      semantic: 0.55,
      hybrid: 0.65,
    });
  });

  it("routes short and multi-label input to keywords and sentences to semantics", () => {
    expect(detectSearchInputMode("AI")).toBe("keyword");
    expect(detectSearchInputMode("城市夜景航拍")).toBe("keyword");
    expect(detectSearchInputMode("海边 小船 夕阳")).toBe("keyword");
    expect(detectSearchInputMode("海边 小船 夕阳 蓝天 航拍")).toBe("keyword");
    expect(detectSearchInputMode("夕阳下一个人在山间行走")).toBe("semantic");
    expect(detectSearchInputMode("帮我找一段适合产品发布的视频")).toBe(
      "semantic",
    );
    expect(detectSearchInputMode("a woman walking on the beach")).toBe(
      "semantic",
    );
  });
});
