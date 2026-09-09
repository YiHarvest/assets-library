import { describe, expect, it, vi } from "vitest";
import { recallAssets, type RecallDependencies } from "@/server/search/v2/recall";
import { experimentalRecallPolicy } from "@/server/search/v2/policy";
import { manifest, tokenizer } from "../helpers/recall";

describe("shared bounded recall coordinator", () => {
  it("rejects candidates that match an isolated phrase but fail its context", async () => {
    const { value, embed, request } = dependencies();
    embed.mockResolvedValue([[1, 0], [0, 1]]);
    request.mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init.body));
      const ids = body.knn?.query_vector[0] === 0 ? ["good"] : ["bad", "good"];
      return Response.json({ hits: { hits: ids.map(assetId => ({ _score: 0.9, _source: { assetId } })) } });
    });
    const result = await recallAssets({ query: "结束了吗", context: "市场红利是否结束", eligibleAssetIds: ["bad", "good"] },
      experimentalRecallPolicy, async () => value);
    expect(result.candidates.map(candidate => candidate.assetId)).toEqual(["good"]);
  });

  it("checks semantic relevance of lexical-only candidates before fusion without losing qualified lexical additions", async () => {
    const { value, request } = dependencies();
    request.mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init.body));
      const hit = (assetId: string, _score: number) => ({ _score, _source: { assetId } });
      const hits = !body.knn ? [hit("wrong", 99), hit("extra", 8)]
        : body.knn.filter.bool.filter[0].terms.assetId.includes("first") ? [hit("first", 0.95)] : [hit("extra", 0.9)];
      return Response.json({ hits: { hits } });
    });
    const result = await recallAssets({ query: "手机自动获客", eligibleAssetIds: ["first", "wrong", "extra"] },
      experimentalRecallPolicy, async () => value);
    expect(result.candidates.map((candidate) => candidate.assetId).sort()).toEqual(["extra", "first"]);
    expect(result.candidates.find((candidate) => candidate.assetId === "extra")?.evidence.vector?.rawScore).toBeCloseTo(0.8);
  });

  it("short-circuits empty scopes and refuses oversized scopes before any external request", async () => {
    const resolve = vi.fn();
    expect((await recallAssets({ query: "海边", eligibleAssetIds: [] }, experimentalRecallPolicy, resolve)).candidates).toEqual([]);
    await expect(recallAssets({ query: "海边", eligibleAssetIds: ["a", "b", "c"] },
      { ...experimentalRecallPolicy, maxEligibleIds: 2 }, resolve)).rejects.toThrow(/范围/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("uses one pinned index and query embedding for both asset routes, then returns the entire fused pool", async () => {
    const { value, embed, request } = dependencies();
    const hit = (assetId: string, chunkId: string, score: number) => ({ _id: assetId, _score: score, _source: { assetId },
      inner_hits: { evidence: { hits: { hits: [{ _source: { chunkId, text: chunkId, sourceRefs: [{ field: "description" }] } }] } } } });
    request.mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ _shards: { failed: 0 }, hits: { hits: !body.knn
        ? [hit("a", "metadata", 8), hit("c", "summary", 7)]
        : body.knn.filter.bool.filter[0].terms.assetId.length === 1 ? [hit("c", "verified", 0.88)]
          : [hit("a", "visual", 0.95), hit("b", "other", 0.9), hit("excluded", "bad", 1)],
      } });
    });
    const resolve = vi.fn(async () => value);
    const result = await recallAssets({ query: " 没有汽车\n2026 ", eligibleAssetIds: ["a", "b", "c"] }, experimentalRecallPolicy, resolve);
    expect(result.candidates.map((candidate) => candidate.assetId)).toEqual(["a", "c", "b"]);
    expect(result.candidates[0]).toMatchObject({ searchScore: 1, evidence: { vector: { chunkId: "visual" }, lexical: { rawScore: 8 } } });
    expect(result.candidates[0].evidence.vector?.rawScore).toBeCloseTo(0.9);
    expect(embed).toHaveBeenCalledExactlyOnceWith([{ text: "没有汽车 2026", tokenCount: tokenizer.count("没有汽车 2026") }]);
    expect(resolve).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      `/${manifest.physicalIndex}/_search?allow_partial_search_results=false`, `/${manifest.physicalIndex}/_search?allow_partial_search_results=false`,
      `/${manifest.physicalIndex}/_search?allow_partial_search_results=false`,
    ]);
    expect(result.diagnostics).toMatchObject({ physicalIndex: manifest.physicalIndex, allowedAssets: 3, fusedAssets: 3 });
    expect(result.diagnostics).not.toHaveProperty("query");
  });

  it("revalidates scope and expands once with the same vector and index, without relaxing relevance gates", async () => {
    const { value, embed, request } = dependencies();
    request.mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ hits: { hits: (body.size === 2 ? ["a", "b"] : ["b", "c", "d", "e"])
        .map((assetId) => ({ _score: 0.9, _source: { assetId } })) } });
    });
    const revalidate = vi.fn(async (ids: string[]) => ids.filter((id) => id !== "a" && id !== "d"));
    const result = await recallAssets({ query: "海边", eligibleAssetIds: ["a", "b", "c", "d", "e"] },
      { ...experimentalRecallPolicy, vectorTopK: 2, lexicalTopK: 2, expansionTopK: 4 }, async () => value, revalidate);
    expect(result.candidates.map((item) => item.assetId)).toEqual(["b", "c", "e"]);
    expect(result.diagnostics).toMatchObject({ expansions: 1, discardedAssets: 2 });
    expect(embed).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(4);
    expect(revalidate).toHaveBeenCalledTimes(2);
    const expanded = JSON.parse(String(request.mock.calls[2][1].body));
    expect(expanded.knn.similarity).toBe(experimentalRecallPolicy.semanticThreshold);
    expect(expanded.knn.filter.bool.filter[0].terms.assetId).toEqual(["b", "c", "d", "e"]);
  });

  it("propagates embedding and shard failures instead of returning an empty or one-route result", async () => {
    const { value, embed, request } = dependencies();
    embed.mockRejectedValueOnce(new Error("model unavailable"));
    await expect(recallAssets({ query: "海边", eligibleAssetIds: ["a"] }, experimentalRecallPolicy, async () => value)).rejects.toThrow("model unavailable");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ _shards: { failed: 1 }, hits: { hits: [] } }));
    await expect(recallAssets({ query: "海边", eligibleAssetIds: ["a"] }, experimentalRecallPolicy, async () => value)).rejects.toThrow(/分片/);
  });
});

// A transport boundary double; query correctness is also tested against real ES.
function dependencies() {
  const embed = vi.fn(async () => [[1, 0]]);
  const request = vi.fn<RecallDependencies["request"]>(async () => Response.json({ hits: { hits: [] }, _shards: { failed: 0 } }));
  const value: RecallDependencies = { manifest, embed, tokenizer, request };
  return { value, embed, request };
}
