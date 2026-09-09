import { describe, expect, it } from "vitest";
import { fuseAssetResults } from "@/server/search/v2/fusion";

describe("asset-level reciprocal rank fusion", () => {
  it("combines evidence across different chunks without letting duplicate chunks consume ranks", () => {
    const ranked = fuseAssetResults([
      { assetId: "a", score: 0.9, chunkId: "a-description" },
      { assetId: "a", score: 0.8, chunkId: "a-timeline" },
      { assetId: "b", score: 0.7, chunkId: "b-description" },
    ], [
      { assetId: "a", score: 8, chunkId: "a-tags" },
      { assetId: "c", score: 7, chunkId: "c-description" },
    ], 60);
    expect(ranked[0]).toMatchObject({ assetId: "a", searchScore: 1, keywordScore: 0.5, semanticScore: 0.5,
      evidence: { vector: { chunkId: "a-description", rank: 1, rawScore: 0.9 }, lexical: { chunkId: "a-tags", rank: 1, rawScore: 8 } } });
    expect(ranked.map((item) => item.assetId)).toEqual(["a", "b", "c"]);
    expect(ranked[1].semanticScore).toBe(61 / (2 * 62));
    expect(ranked[2].keywordScore).toBe(ranked[1].semanticScore);
  });
});
