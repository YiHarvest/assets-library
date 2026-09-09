import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetSearchChunks, deleteAssetIndex, fuseResults, indexAsset, rerank, searchAssets } from "@/server/search/elasticsearch";
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
  vi.stubEnv("ELASTICSEARCH_INDEX", "assets_test");
  vi.stubEnv("EMBEDDING_BASE_URL", "https://embedding.example.test/v1");
  vi.stubEnv("EMBEDDING_MODEL", "test-embedding");
  vi.stubEnv("SEARCH_RERANK_ENABLED", "false");
  vi.stubEnv("SEARCH_SEMANTIC_THRESHOLD", "0.6");
  vi.stubEnv("SEARCH_KEYWORD_THRESHOLD", "12");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ES asset recall", () => {
  it("fuses chunk ranks before keeping the best chunk per asset", () => {
    const result = fuseResults(["a:0", "a:1", "b:0"].map(chunk), ["a:1", "b:0", "a:2"].map(chunk), 60);
    expect(result.map((item) => item.assetId)).toEqual(["a", "b"]);
    expect(result[0].searchScore).toBeCloseTo(61 / 124 + 0.5);
    expect(result[1].searchScore).toBeCloseTo(61 / 126 + 61 / 124);
    // 同一素材的不同块在两路各排第一，不能当作同一个块叠加到 1 分。
    expect(fuseResults([chunk("a:0")], [chunk("a:1")], 60)[0].searchScore).toBe(0.5);
    expect(fuseResults([chunk("a:0")], [chunk("a:0")], 60)[0].searchScore).toBe(1);
    expect(fuseResults([], [], 60)).toEqual([]);
  });

  it("keeps descriptions and summaries as separate original chunks without truncation", () => {
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
    expect(assetSearchChunks(video)).toEqual(["人工描述", "走在海边", "转身挥手", "走向远方"]);
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
      { index: { _id: "asset-a:0" } }, { assetId: "asset-a", content: "人工描述", embedding: [0.1, 0.2] },
      { index: { _id: "asset-a:1" } }, { assetId: "asset-a", content: "走在海边", embedding: [0.3, 0.4] },
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
    expect(result.map((item) => item.assetId)).toEqual(["b", "a"]);
    const vector = JSON.parse(fetchMock.mock.calls[1][1].body);
    const keyword = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(vector.knn.filter).toEqual({ terms: { assetId: ["a", "b"] } });
    expect(vector.knn.similarity).toBe(0.6);
    expect(keyword.min_score).toBe(12);
    expect(vector).not.toHaveProperty("query");
    expect(vector._source).toEqual(["assetId"]);
    expect(keyword.query.bool.filter).toEqual([vector.knn.filter]);
    expect(keyword).not.toHaveProperty("knn");
    expect(keyword.query.bool.must).toEqual([{ match: { content: "夕阳下的海边 小船" } }]);
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
