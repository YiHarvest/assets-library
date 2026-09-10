import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetSearchChunks, assetSearchMetadata, deleteAssetIndex, fuseResults, indexAsset, rerank, searchAssets } from "@/server/search/elasticsearch";
import { apiV1ErrorResponse } from "@/server/api/handler";
import { loadConfig } from "@/server/config";
import type { AssetDetail } from "@/shared/contracts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const chunk = (chunkId: string) => ({ chunkId, assetId: chunkId.split(":")[0] });
const hits = (ids: string[]) => ({ hits: { hits: ids.map((_id) => ({ _id, _score: 1, _source: { assetId: chunk(_id).assetId } })) } });
const asset: AssetDetail = {
  id: "asset-a", name: "新名称", description: "人工描述", tags: [{ category: "scene", value: "海边" }],
  mediaType: "image", processingStatus: "completed", reviewStatus: "published",
  mediaUrl: "/media/a", createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z", originalFilename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10,
  failureCode: null, failureMessage: null, segmentStartMs: null, segmentEndMs: null,
  analysis: { kind: "image", description: "旧描述", tags: { scene: ["已删除标签"], object: [], person: [], style: [], color_composition: [] }, ocr: { text: "欢迎", unavailableReason: null } },
};

beforeEach(() => {
  vi.stubEnv("ELASTICSEARCH_URL", "https://es.example.test");
  vi.stubEnv("APP_MODE", "dev");
  vi.stubEnv("DEV_ELASTICSEARCH_INDEX", "assets_test");
  vi.stubEnv("EMBEDDING_BASE_URL", "https://embedding.example.test/v1");
  vi.stubEnv("EMBEDDING_MODEL", "test-embedding");
  vi.stubEnv("SEARCH_RERANK_ENABLED", "false");
  vi.stubEnv("SEARCH_SEMANTIC_THRESHOLD", "0.6");
  vi.stubEnv("SEARCH_KEYWORD_THRESHOLD", "12");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ES asset recall", () => {
  it("does not admit black footage for unrelated text even with a high embedding score", () => {
    const hits = [{ ...chunk("black:1"), score: 0.8 }];
    const sceneHits = [{ ...chunk("black:0"), score: 0.8, content: "视频全程为黑屏画面，无任何可见视觉内容。" }];
    expect(fuseResults(hits, [], 60, [], 0.5, { sceneHits, query: "丝毫全是自己" })).toEqual([]);
    expect(fuseResults(hits, [], 60, [], 0.5, { sceneHits, query: "黑屏过渡" })).toHaveLength(1);
  });
  it("rejects a weak UI match without scene support while retaining semantic scene matches", () => {
    const result = fuseResults([
      { ...chunk("contacts:1"), score: 0.53 }, { ...chunk("burden:1"), score: 0.58 },
    ], [chunk("contacts:metadata")], 60, [
      { ...chunk("contacts:1"), score: 0.457 }, { ...chunk("burden:1"), score: 0.462 },
    ], 0.5, { sceneHits: [
      { ...chunk("contacts:0"), score: 0.452 }, { ...chunk("burden:0"), score: 0.469 },
    ] });
    expect(result.map(item => item.assetId)).toEqual(["burden"]);
    expect(result[0].matchQuality).toBeGreaterThan(0.5);
  });

  it("never lets a whole-video description rescue a weak or absent playback match", () => {
    expect(fuseResults([{ ...chunk("late:1"), score: 0.49 }], [chunk("late:0")], 60, [], 0.5,
      { sceneHits: [{ ...chunk("late:0"), score: 0.95 }] })).toEqual([]);
    const [result] = fuseResults([{ ...chunk("early:1"), score: 0.6 }], [], 60, [], 0.5,
      { sceneHits: [{ ...chunk("early:0"), score: 0.95 }] });
    expect(result.matchQuality).toBe(0.6);
  });

  it("requires the complete context for a fragment instead of accepting a literal pose match", () => {
    const result = fuseResults([{ ...chunk("pose:0"), score: 0.8 }, { ...chunk("work:0"), score: 0.4 }], [], 60,
      [{ ...chunk("pose:0"), score: 0.3 }, { ...chunk("work:0"), score: 0.8 }], 0.5, { contextRequired: true });
    expect(result.map(item => item.assetId)).toEqual(["work"]);
    expect(result[0].matchQuality).toBeCloseTo(0.72);
  });

  it("limits both lexical directions to one combined vote and records field evidence", () => {
    const result = fuseResults([{ ...chunk("a:0"), score: 0.7 }], [{ ...chunk("a:metadata"), matchedFields: ["facets.topic"] }], 60, [], 0.5,
      { visualHits: [{ ...chunk("a:metadata"), matchedFields: ["facets.person", "facets.scene"] }] });
    expect(result[0]).toMatchObject({ searchScore: 1, semanticScore: 0.5, keywordScore: 0.5, matchedFields: ["facets.topic", "facets.person", "facets.scene"] });
    expect(result[0].matchQuality).toBeCloseTo(0.71);
  });

  it("rejects late and whole-video evidence even when BM25 strongly matches it", async () => {
    vi.stubEnv("SEARCH_SEMANTIC_THRESHOLD", "0.5");
    const rows = [
      { assetId: "late", evidenceKind: "summary", score: 0.99 },
      { assetId: "late", evidenceKind: "point", startMs: 4000, score: 0.9 },
      { assetId: "early", evidenceKind: "point", startMs: 200, score: 0.7 },
    ];
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/embeddings")) return json({ data: [{ index: 0, embedding: [1, 0] }] });
      const body = JSON.parse(String(init.body)); requests.push(body);
      return json({ hits: { hits: rows.map(({ score, ..._source }, i) => ({ _id: `${_source.assetId}:${i}`, _source,
        _score: body.knn || body.query?.script_score ? (score + 1) / 2 : 100, matched_queries: ["events"] })) } });
    }));
    const result = await searchAssets("账号异常", ["late", "early"], undefined, undefined, { playbackDurationMs: 1480 });
    expect(result.map(item => item.assetId)).toEqual(["early"]);
    expect(result[0].playbackEvidence).toEqual([{ kind: "point", startMs: 200, similarity: expect.closeTo(0.7) }]);
    expect(JSON.stringify(requests[0])).toContain('"lt":1480');
    expect(JSON.stringify(requests.find(body => JSON.stringify(body).includes("script_score")))).toContain('"lte":1480');
  });

  it("admits context matches and verifies keyword candidates against visual semantics", async () => {
    vi.stubEnv("SEARCH_SEMANTIC_THRESHOLD", "0.5");
    const scored = (values: Record<string, number>, lexical = false) => json({ hits: { hits: Object.entries(values)
      .map(([id, score]) => ({ _id: `${id}:0`, _score: lexical ? score : (score + 1) / 2, _source: { assetId: id } })) } });
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/embeddings")) return json({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] });
      const body = JSON.parse(String(init.body));
      if (body.query?.script_score?.query?.bool?.filter?.some((filter: { terms?: { evidenceKind?: string[] } }) => filter.terms?.evidenceKind))
        return json({ hits: { hits: [] } }); // Legacy fixtures have no scene documents.
      if (body.query?.script_score) return body.query.script_score.script.params.vector[1] === 1
        ? scored({ visual: 0.3, unrelated: 0.2 }) : scored({ "context-only": 0.4, unrelated: 0.2 });
      if (!body.knn) return scored({ unrelated: 100, good: 20 }, true);
      return body.knn.query_vector[1] === 1 ? scored({ good: 0.8, "context-only": 0.7 }) : scored({ visual: 0.7, good: 0.62 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchAssets("的姿势", ["visual", "good", "context-only", "unrelated"], undefined, "普通人用人工智能提高工作效率");
    expect(result.map(candidate => candidate.assetId)).toEqual(["good", "visual", "context-only"]);
    expect(result[0].matchQuality).toBeCloseTo(0.674);
    expect(result.find(item => item.assetId === "context-only")).toMatchObject({ semanticSimilarity: expect.closeTo(0.4), contextSimilarity: expect.closeTo(0.7) });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).knn.similarity).toBe(0.5);
  });

  it.each(["家和万事兴", "是母亲", "是父亲"])("keeps %s when only the short phrase passes the semantic threshold", async (query) => {
    vi.stubEnv("SEARCH_SEMANTIC_THRESHOLD", "0.5");
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/embeddings")) return json({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] });
      const body = JSON.parse(String(init.body));
      return json(hits(body.knn?.query_vector[0] === 1 ? ["visual:0"] : []));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchAssets(query, ["visual"], undefined, "父爱则母静，母静则子安，家和万事兴");
    expect(result).toMatchObject(fuseResults([{ ...chunk("visual:0"), score: 1 }], [], 60));
    expect(result[0].playbackEvidence).toEqual([{ kind: "unknown", similarity: 1 }]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).knn.similarity).toBe(0.5);
  });

  it("counts each route once per asset and keeps RRF scores normalized", () => {
    const result = fuseResults([chunk("a:0")], [chunk("a:0")], 60, ["a:1", "a:2"].map(chunk));
    expect(result).toMatchObject([{ assetId: "a", searchScore: 1, semanticScore: 0.5, keywordScore: 0.5 }]);
    expect(fuseResults([], [], 60, [{ ...chunk("context-only:0"), score: 0.7 }])).toMatchObject([{ assetId: "context-only", searchScore: 0.5 }]);
    expect(fuseResults([{ ...chunk("a:0"), score: 0.49 }], [chunk("a:metadata")], 60)).toEqual([]);
  });

  it("keeps raw phrase similarity separate from RRF and context scores", () => {
    const [result] = fuseResults([{ ...chunk("a:0"), score: 0.51 }], [chunk("a:1")], 60,
      [{ ...chunk("a:2"), score: 0.9 }]);
    expect(result.semanticSimilarity).toBe(0.51);
    expect(result.semanticSimilarity).not.toBe(result.semanticScore);
  });

  it("deduplicates asset IDs before fusion so repeated chunks cannot crowd the ranks", () => {
    const result = fuseResults(["a:0", "a:1", "b:0"].map(chunk), ["a:1", "b:0", "a:2"].map(chunk), 60);
    expect(result.map(item => item.assetId)).toEqual(["a", "b"]);
    expect(result[0].searchScore).toBe(1);
    expect(result[1].searchScore).toBeCloseTo(61 / 62);
    expect(fuseResults([chunk("a:0")], [chunk("a:metadata")], 60)[0].searchScore).toBe(1);
    expect(fuseResults([], [], 60)).toEqual([]);
  });

  it("uses only current meaningful tags as BM25 metadata", () => {
    expect(assetSearchMetadata(asset)).toBe("海边");
    expect(assetSearchMetadata({ tags: [
      { category: "scene", value: "科技" }, { category: "form", value: "固定视角" },
      { category: "topic", value: "账号违规" }, { category: "person", value: "年轻人" },
      { category: "topic", value: "账号违规" },
    ] })).toBe("账号违规，年轻人");
    expect(assetSearchMetadata({ ...asset, tags: [] })).toBe("");
  });

  it("keeps timed summaries independent from the whole-video description", () => {
    expect(assetSearchChunks(asset)).toEqual(["人工描述"]);
    const longDescription = "这是完整原文。".repeat(1500);
    expect(assetSearchChunks({ description: longDescription, analysis: null })).toEqual([longDescription]);
    const video = {
      ...asset,
      analysis: {
        kind: "video" as const, description: "旧描述", topics: ["排除的主题"],
        tags: { scene: ["排除的标签"], person: [], form: [] },
        visualSegments: [{ startSeconds: 0, endSeconds: 1, summary: "走在海边" }],
        keyMoments: [{ seconds: 1, summary: "走在海边" }, { seconds: 2, summary: "转身挥手" }],
        timeline: [{ startSeconds: 0, endSeconds: 2, summary: "  " }, { startSeconds: 2, endSeconds: 3, summary: "走向远方" }],
      },
    };
    expect(assetSearchChunks(video)).toEqual(["人工描述", "走在海边", "走向远方", "转身挥手"]);
    const contextual = { ...video, description: "手机端电商平台个人中心，浅色背景。", analysis: {
      ...video.analysis, visualSegments: [], keyMoments: [],
      timeline: [{ startSeconds: 0, endSeconds: 2, summary: "展示订单状态栏及互动任务入口。" }],
    } };
    expect(assetSearchChunks(contextual)).toEqual([
      contextual.description, "展示订单状态栏及互动任务入口。",
    ]);
    expect(assetSearchChunks({ ...contextual, description: "" })).toEqual(["展示订单状态栏及互动任务入口。"]);
    expect(assetSearchChunks({ ...contextual, description: "展示订单状态栏及互动任务入口。" }))
      .toEqual(["展示订单状态栏及互动任务入口。"]);
  });

  it("embeds a batch, removes prior documents and bulk writes each chunk with its vector", async () => {
    const video = { ...asset, analysis: {
      kind: "video" as const, description: "旧描述", topics: [], tags: { scene: [], person: [], form: [] },
      visualSegments: [{ startSeconds: 0, endSeconds: 1, summary: "走在海边" }], keyMoments: [], timeline: [],
    } };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [
      { index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] },
    ] }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ acknowledged: true }))
      .mockResolvedValueOnce(json({ deleted: 3, failures: [] }))
      .mockResolvedValueOnce(json({ errors: false }));
    vi.stubGlobal("fetch", fetchMock);
    await indexAsset(video);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(["人工描述", "走在海边"]);
    const mapping = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(mapping.mappings.properties.embedding).toMatchObject({ type: "dense_vector", dims: 2, similarity: "cosine" });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ query: { term: { assetId: "asset-a" } } });
    const bulk = fetchMock.mock.calls[4];
    expect(bulk[0]).toContain("/_bulk?refresh=wait_for");
    expect(bulk[1].headers["content-type"]).toBe("application/x-ndjson");
    expect(bulk[1].body.endsWith("\n")).toBe(true);
    expect(bulk[1].body.trim().split("\n").map((line: string) => JSON.parse(line))).toEqual([
      { index: { _id: "asset-a:0" } }, { assetId: "asset-a", content: "人工描述", evidenceKind: "summary", embedding: [0.1, 0.2] },
      { index: { _id: "asset-a:1" } }, { assetId: "asset-a", content: "走在海边", events: "走在海边", evidenceKind: "range", startMs: 0, endMs: 1000, embedding: [0.3, 0.4] },
      { index: { _id: "asset-a:metadata" } }, { assetId: "asset-a", content: "海边", facets: { topic: [], scene: ["海边"], person: [], object: [] } },
    ]);
  });

  it("clears old documents when a material no longer has searchable text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ deleted: 2, failures: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await indexAsset({ ...asset, description: "" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/_delete_by_query");
  });

  it("reports bulk item failures even when ES returns HTTP 200", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ index: 0, embedding: [1, 2] }] }))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(json({ deleted: 0, failures: [] }))
      .mockResolvedValueOnce(json({ errors: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(indexAsset(asset)).rejects.toThrow("分块批量写入失败");
  });

  it.each(["false", "true"])("uses independent filtered ES requests and rerank switch=%s", async (enabled) => {
    vi.stubEnv("SEARCH_RERANK_ENABLED", enabled);
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/embeddings")) return json({ data: [{ embedding: [1, 2] }] });
      const body = JSON.parse(String(init.body));
      return json(hits(body.knn ? ["a:0", "a:1", "b:0", "outside:0"] : ["b:0", "a:1", "outside:0"]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchAssets("夕阳下的海边 小船", ["a", "b"]);
    expect(result.map((item) => item.assetId)).toEqual(["a", "b"]);
    const vector = JSON.parse(fetchMock.mock.calls[1][1].body);
    const keyword = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(vector.knn.filter).toEqual({ terms: { assetId: ["a", "b"] } });
    expect(vector.knn.similarity).toBe(0.6);
    expect(keyword.min_score).toBe(12);
    expect(vector).not.toHaveProperty("query");
    expect(vector._source).toEqual(["assetId", "evidenceKind", "startMs", "endMs", "content"]);
    expect(keyword.query.bool.filter).toEqual([vector.knn.filter]);
    expect(keyword).not.toHaveProperty("knn");
    expect(keyword.query.bool.should).toContainEqual({ match: { content: { query: "夕阳下的海边 小船", boost: 2 } } });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).query.bool.should).toHaveLength(2);
    expect(await rerank("query", result)).toBe(result);
  });

  it("returns an explicit client error for embedding failure without keyword fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    const error = await searchAssets("海边", ["a"]).catch((error) => error);
    const response = apiV1ErrorResponse(error);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "model_request_failed", message: "Embedding 服务返回 HTTP 503。" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed vectors and ES partial results rather than returning an empty success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [{ embedding: ["bad"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAssets("海边", ["a"])).rejects.toMatchObject({ code: "model_response_invalid" });
    fetchMock.mockReset().mockResolvedValueOnce(json({ data: [{ embedding: [1, 2] }] }))
      .mockImplementation(async () => json({ ...hits(["a"]), timed_out: true }));
    await expect(searchAssets("海边", ["a"])).rejects.toThrow("Elasticsearch 检索超时");
  });

  it("deletes all chunks by asset ID and skips empty scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}, 404));
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchAssets("海边", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await deleteAssetIndex("asset-a");
    expect(fetchMock.mock.calls[0][0]).toContain("/assets_test/_delete_by_query?refresh=true");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: { term: { assetId: "asset-a" } } });
  });

  it("validates search configuration", () => {
    vi.stubEnv("SEARCH_VECTOR_TOP_K", "0");
    expect(() => loadConfig()).toThrow();
  });

  it.each([
    ["SEARCH_SEMANTIC_THRESHOLD", "1.1"],
    ["SEARCH_SEMANTIC_THRESHOLD", "-1.1"],
    ["SEARCH_KEYWORD_THRESHOLD", "-1"],
  ])("rejects invalid %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => loadConfig()).toThrow();
  });
});
