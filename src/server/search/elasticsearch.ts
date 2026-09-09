import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import type { AssetDetail } from "@/shared/contracts";

export interface SearchCandidate {
  assetId: string;
  searchScore: number;
  keywordScore?: number;
  semanticScore?: number;
}

/** 每个描述/摘要独立成块；不混入名称、标签、topics 或 OCR。 */
export function assetSearchChunks(asset: Pick<AssetDetail, "description" | "analysis">) {
  const analysis = asset.analysis;
  return [...new Set([
    asset.description,
    ...(analysis?.kind === "video" ? [
      ...analysis.visualSegments.map((item) => item.summary),
      ...analysis.keyMoments.map((item) => item.summary),
      ...analysis.timeline.map((item) => item.summary),
    ] : []),
  ].map((text) => text.trim()).filter(Boolean))];
}

export async function embedTexts(texts: string[]) {
  const config = loadConfig();
  if (!config.embeddingBaseUrl || !config.EMBEDDING_MODEL) {
    throw new AppError("model_not_configured", "Embedding 服务尚未配置。", 503);
  }
  let response: Response;
  try {
    response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("model_request_failed", "Embedding 服务连接失败或请求超时。", 503);
  }
  if (!response.ok) {
    throw new AppError("model_request_failed", `Embedding 服务返回 HTTP ${response.status}。`, 502);
  }
  const payload = await response.json().catch(() => null);
  const entries = payload?.data as Array<{ index: number; embedding: number[] }> | undefined;
  const vectors = Array.isArray(entries)
    ? [...entries].sort((a, b) => a.index - b.index).map((item) => item.embedding) : [];
  if (vectors.length !== texts.length || vectors.some((vector) =>
    !Array.isArray(vector) || !vector.length ||
    !vector.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    !vector.some((value) => value !== 0))) {
    throw new AppError("model_response_invalid", "Embedding 服务返回无效向量。", 502);
  }
  return vectors;
}

async function esRequest(path: string, init?: RequestInit, allowedStatuses: number[] = []) {
  const config = loadConfig();
  if (!config.ELASTICSEARCH_URL) {
    throw new AppError("storage_error", "Elasticsearch 服务尚未配置。", 503);
  }
  let response: Response;
  try {
    response = await fetch(`${config.ELASTICSEARCH_URL.replace(/\/$/, "")}/${encodeURIComponent(config.ELASTICSEARCH_INDEX)}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
        ...(config.ELASTICSEARCH_USERNAME ? {
          authorization: `Basic ${Buffer.from(`${config.ELASTICSEARCH_USERNAME}:${config.ELASTICSEARCH_PASSWORD ?? ""}`).toString("base64")}`,
        } : {}),
      },
      signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("storage_error", "Elasticsearch 服务连接失败或请求超时。", 503);
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new AppError("storage_error", `Elasticsearch 请求失败：HTTP ${response.status}。`, 502);
  }
  return response;
}

async function ensureIndex(dimensions: number) {
  const exists = await esRequest("", { method: "HEAD" }, [404]);
  if (exists.ok) return;
  const analyzer = loadConfig().ELASTICSEARCH_ANALYZER;
  const response = await esRequest("", {
    method: "PUT",
    body: JSON.stringify({ mappings: { properties: {
      assetId: { type: "keyword" },
      content: { type: "text", analyzer, search_analyzer: analyzer },
      embedding: { type: "dense_vector", dims: dimensions, index: true, similarity: "cosine" },
    } } }),
  }, [400]);
  if (!response.ok) {
    const payload = await response.json();
    // 多个索引任务可能同时创建同一索引。
    if (payload.error?.type !== "resource_already_exists_exception") {
      throw new AppError("storage_error", `Elasticsearch 创建索引失败：${payload.error?.type ?? response.status}。`, 502);
    }
  }
}

export async function indexAsset(asset: AssetDetail) {
  const chunks = assetSearchChunks(asset);
  if (!chunks.length) {
    await deleteAssetIndex(asset.id);
    return;
  }
  const vectors = await embedTexts(chunks);
  await ensureIndex(vectors[0].length);
  // ponytail: 素材级删除后批量重建不是原子操作；需要并发重建同一素材时再串行化。
  await deleteAssetIndex(asset.id);
  const operations = chunks.flatMap((content, index) => [
    { index: { _id: `${asset.id}:${index}` } },
    { assetId: asset.id, content, embedding: vectors[index] },
  ]);
  const response = await esRequest("/_bulk?refresh=wait_for", {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: operations.map((operation) => JSON.stringify(operation)).join("\n") + "\n",
  });
  const result = await response.json();
  if (result.errors) {
    throw new AppError("storage_error", "Elasticsearch 分块批量写入失败。", 502);
  }
}

/** 同时清理当前分块和旧版单文档索引。 */
export async function deleteAssetIndex(assetId: string) {
  const response = await esRequest("/_delete_by_query?refresh=true", {
    method: "POST",
    body: JSON.stringify({ query: { term: { assetId } } }),
  }, [404]);
  if (response.status === 404) return;
  const result = await response.json();
  if (result.timed_out || result.failures?.length) {
    throw new AppError("storage_error", "Elasticsearch 素材分块删除失败。", 502);
  }
}

interface ChunkHit {
  chunkId: string;
  assetId: string;
}

/** 先按分块排名做等权 RRF，再按素材保留分数最高的块。 */
export function fuseResults(vectorHits: ChunkHit[], keywordHits: ChunkHit[], k: number): SearchCandidate[] {
  const chunks = new Map<string, SearchCandidate>();
  for (const [hits, field] of [
    [vectorHits, "semanticScore"], [keywordHits, "keywordScore"],
  ] as const) {
    hits.forEach(({ chunkId, assetId }, index) => {
      const candidate = chunks.get(chunkId) ?? { assetId, searchScore: 0 };
      const contribution = (k + 1) / (2 * (k + index + 1));
      candidate[field] = contribution;
      candidate.searchScore += contribution;
      chunks.set(chunkId, candidate);
    });
  }
  const ranked = [...chunks.entries()].sort(([leftId, left], [rightId, right]) =>
    right.searchScore - left.searchScore || leftId.localeCompare(rightId));
  const assets = new Map<string, SearchCandidate>();
  for (const [, candidate] of ranked) {
    if (!assets.has(candidate.assetId)) assets.set(candidate.assetId, candidate);
  }
  return [...assets.values()];
}

/** 后续在这里实现重排；当前保留 RRF 顺序和分数。 */
export async function rerank(query: string, candidates: SearchCandidate[]) {
  void query;
  return candidates;
}

interface SearchHits {
  timed_out?: boolean;
  _shards?: { failed: number };
  hits: { hits: Array<{ _id: string; _score: number; _source: { assetId: string } }> };
}

/** 两路原始分块分数供检索与离线阈值评测共用，不作为 API 的 RRF 分项分数。 */
export async function recallChunks(query: string, assetIds: string[]) {
  if (!assetIds.length) return [[], []];
  const config = loadConfig();
  const [vector] = await embedTexts([query]);
  const filter = { terms: { assetId: assetIds } };
  const bodies = [
    {
      size: config.SEARCH_VECTOR_TOP_K,
      _source: ["assetId"],
      knn: {
        field: "embedding", query_vector: vector,
        k: config.SEARCH_VECTOR_TOP_K,
        similarity: config.SEARCH_SEMANTIC_THRESHOLD,
        num_candidates: Math.max(config.SEARCH_VECTOR_TOP_K, config.SEARCH_NUM_CANDIDATES),
        filter,
      },
    },
    {
      size: config.SEARCH_KEYWORD_TOP_K,
      min_score: config.SEARCH_KEYWORD_THRESHOLD,
      _source: ["assetId"],
      query: { bool: { must: [{ match: { content: query } }], filter: [filter] } },
      sort: [{ _score: "desc" }, { assetId: "asc" }],
    },
  ];
  return Promise.all(bodies.map(async (body, route) => {
    const response = await esRequest("/_search?allow_partial_search_results=false", {
      method: "POST", body: JSON.stringify(body),
    });
    const result = await response.json() as SearchHits;
    if (result.timed_out || result._shards?.failed) {
      throw new AppError("storage_error", "Elasticsearch 检索超时或分片失败。", 503);
    }
    const allowed = new Set(assetIds);
    return result.hits.hits
      .filter((hit) => allowed.has(hit._source.assetId))
      .map((hit) => ({
        chunkId: hit._id, assetId: hit._source.assetId,
        score: route === 0 ? 2 * hit._score - 1 : hit._score,
      }));
  }));
}

export async function searchAssets(query: string, assetIds: string[]): Promise<SearchCandidate[]> {
  if (!assetIds.length) return [];
  const config = loadConfig();
  const results = await recallChunks(query, assetIds);
  const candidates = fuseResults(results[0], results[1], config.SEARCH_RRF_K);
  return config.SEARCH_RERANK_ENABLED ? rerank(query, candidates) : candidates;
}
