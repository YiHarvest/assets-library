import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import type { AssetDetail } from "@/shared/contracts";
import { searchWithV2 } from "./v2/facade";
import { assetEvidence, evidenceInWindow, permitsVisualMatch, type PlaybackEvidence } from "./asset-evidence";

export interface RecallOptions { playbackDurationMs?: number; contextRequired?: boolean }

export interface SearchCandidate {
  assetId: string;
  searchScore: number;
  keywordScore?: number;
  semanticScore?: number;
  /** 单句原始余弦相似度，仅供内部短视频组合资格判断。 */
  semanticSimilarity?: number;
  contextSimilarity?: number;
  sceneSimilarity?: number;
  matchQuality?: number;
  playbackEvidence?: PlaybackEvidence[];
  matchedFields?: string[];
}

/** 不把整片描述混入带时间的事实，避免片尾信息污染片头。 */
export function assetSearchChunks(asset: Pick<AssetDetail, "description" | "analysis">) {
  return [...new Set(assetEvidence({ ...asset, tags: [] }).chunks.map(chunk => chunk.content))];
}

/** 只读取当前有效标签；模型 JSON 中被人工删除的标签不能重新进入索引。 */
export function assetSearchMetadata(asset: Pick<AssetDetail, "tags">) {
  return [...new Set(Object.values(assetEvidence({ ...asset, description: "", analysis: null }).facets).flat())].join("，");
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
      evidenceKind: { type: "keyword" }, startMs: { type: "long" }, endMs: { type: "long" },
      events: { type: "text", analyzer },
      facets: { properties: Object.fromEntries(["topic", "scene", "person", "object"].map(field => [field, { type: "text", analyzer }])) },
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
  const { chunks, facets } = assetEvidence(asset);
  if (!chunks.length) {
    await deleteAssetIndex(asset.id);
    return;
  }
  const texts = [...new Set(chunks.map(chunk => chunk.content))];
  const vectors = await embedTexts(texts);
  await ensureIndex(vectors[0].length);
  // ponytail: 素材级删除后批量重建不是原子操作；需要并发重建同一素材时再串行化。
  await deleteAssetIndex(asset.id);
  const operations: object[] = chunks.flatMap(({ content, kind, ...time }, index) => [
    { index: { _id: `${asset.id}:${index}` } },
    { assetId: asset.id, content, evidenceKind: kind, ...time, ...(kind === "range" || kind === "point" ? { events: content } : {}),
      embedding: vectors[texts.indexOf(content)] },
  ]);
  // 元数据单独作为 BM25 文档，每个素材只写一次，不生成或污染视觉向量。
  const metadata = assetSearchMetadata(asset);
  if (metadata) operations.push({ index: { _id: `${asset.id}:metadata` } }, { assetId: asset.id, content: metadata, facets });
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
  score?: number;
  content?: string;
  evidence?: Omit<PlaybackEvidence, "similarity">;
  matchedFields?: string[];
}

/** 素材级 RRF：完整局部语境参与语义召回，BM25 不能绕过语义门槛。 */
export function fuseResults(vectorHits: ChunkHit[], keywordHits: ChunkHit[], k: number, contextHits: ChunkHit[] = [], threshold = 0.5,
  options: RecallOptions & { visualHits?: ChunkHit[]; sceneHits?: ChunkHit[]; query?: string } = {}): SearchCandidate[] {
  const byAsset = (hits: ChunkHit[]) => {
    const assets = new Map<string, ChunkHit>();
    for (const hit of hits) if (!assets.has(hit.assetId) || (hit.score ?? -1) > (assets.get(hit.assetId)!.score ?? -1)) assets.set(hit.assetId, hit);
    return assets;
  };
  const focus = byAsset(vectorHits), context = byAsset(contextHits);
  const scenes = byAsset(options.sceneHits ?? []);
  const candidates = new Map<string, SearchCandidate>();
  for (const assetId of new Set([...focus.keys(), ...context.keys()])) {
    if (options.query !== undefined && !permitsVisualMatch(scenes.get(assetId)?.content ?? focus.get(assetId)?.content ?? "", options.query)) continue;
    const semanticSimilarity = focus.get(assetId)?.score, contextSimilarity = context.get(assetId)?.score;
    if (options.contextRequired && (contextSimilarity ?? -1) < threshold) continue;
    if (Math.max(semanticSimilarity ?? -1, contextSimilarity ?? -1) < threshold &&
      !(focus.has(assetId) && semanticSimilarity === undefined)) continue;
    let matchQuality = options.contextRequired ? 0.9 * contextSimilarity! : semanticSimilarity === undefined ? contextSimilarity : contextSimilarity === undefined
      ? semanticSimilarity : 0.7 * semanticSimilarity + 0.3 * contextSimilarity;
    const sceneSimilarity = scenes.get(assetId)?.score;
    // 整片描述只校验局部高分，不能把片尾事实变成片头的命中证据。
    if (sceneSimilarity !== undefined && matchQuality !== undefined) {
      matchQuality = Math.min(matchQuality, 0.75 * matchQuality + 0.25 * sceneSimilarity);
      if (matchQuality < threshold) continue;
    }
    const evidence = (options.contextRequired ? contextHits : vectorHits).filter(hit => hit.assetId === assetId && hit.evidence && hit.score !== undefined)
      .map(hit => ({ ...hit.evidence!, similarity: hit.score! }));
    candidates.set(assetId, { assetId, searchScore: 0, semanticSimilarity, contextSimilarity, sceneSimilarity, matchQuality,
      ...(evidence.length ? { playbackEvidence: evidence } : {}) });
  }
  const semantic = [...candidates.values()].sort((a, b) => (b.matchQuality ?? 0) - (a.matchQuality ?? 0));
  const lexical = (hits: ChunkHit[]) => [...byAsset(hits).keys()].filter(id => candidates.has(id)).map(id => candidates.get(id)!);
  const routes: Array<[SearchCandidate[], "semanticScore" | "keywordScore", number]> = [
    [semantic, "semanticScore", 0.5], [lexical(keywordHits), "keywordScore", options.visualHits ? 0.25 : 0.5],
    ...(options.visualHits ? [[lexical(options.visualHits), "keywordScore", 0.25] as [SearchCandidate[], "keywordScore", number]] : []),
  ];
  for (const [items, field, weight] of routes) items.forEach((candidate, rank) => {
    const contribution = weight * (k + 1) / (k + rank + 1);
    candidate[field] = (candidate[field] ?? 0) + contribution;
    candidate.searchScore += contribution;
  });
  for (const candidate of candidates.values()) {
    const fields = [...new Set([...keywordHits, ...(options.visualHits ?? [])].filter(hit => hit.assetId === candidate.assetId).flatMap(hit => hit.matchedFields ?? []))];
    if (fields.length) {
      candidate.matchedFields = fields;
      if (candidate.matchQuality !== undefined) candidate.matchQuality = Math.min(1, candidate.matchQuality + 0.02 * (candidate.keywordScore ?? 0));
    }
  }
  return [...candidates.values()].sort((a, b) => b.searchScore - a.searchScore);
}

/** 后续在这里实现重排；当前保留 RRF 顺序和分数。 */
export async function rerank(query: string, candidates: SearchCandidate[]) {
  void query;
  return candidates;
}

interface SearchHits {
  timed_out?: boolean;
  _shards?: { failed: number };
  hits: { hits: Array<{ _id: string; _score: number; matched_queries?: string[];
    _source: { assetId: string; content?: string; evidenceKind?: PlaybackEvidence["kind"]; startMs?: number; endMs?: number } }> };
}

/** 当前句、局部语境及两个词法方向的分块分数，不作为 API 的 RRF 分项分数。 */
export async function recallChunks(query: string, assetIds: string[], context?: string, options: RecallOptions = {}) {
  if (!assetIds.length) return [[], []];
  const config = loadConfig();
  const [vector, contextVector] = await embedTexts(context && context.trim() !== query.trim() ? [query, context] : [query]);
  const filter = { terms: { assetId: assetIds } };
  const window = options.playbackDurationMs === undefined ? [] : [{ bool: { should: [
    { bool: { filter: [{ term: { evidenceKind: "point" } }, { range: { startMs: { lt: options.playbackDurationMs } } }] } },
    { bool: { filter: [{ term: { evidenceKind: "range" } }, { range: { endMs: { lte: options.playbackDurationMs } } }] } },
    { terms: { evidenceKind: ["static", "unknown"] } }, { bool: { must_not: { exists: { field: "evidenceKind" } } } },
  ], minimum_should_match: 1 } }];
  const vectorFilter = window.length ? { bool: { filter: [filter, ...window] } } : filter;
  const source = ["assetId", "evidenceKind", "startMs", "endMs", "content"];
  const bodies = [
    {
      size: config.SEARCH_VECTOR_TOP_K,
      _source: source,
      knn: {
        field: "embedding", query_vector: vector,
        k: config.SEARCH_VECTOR_TOP_K,
        similarity: config.SEARCH_SEMANTIC_THRESHOLD,
        num_candidates: Math.max(config.SEARCH_VECTOR_TOP_K, config.SEARCH_NUM_CANDIDATES),
        filter: vectorFilter,
      },
    },
    {
      size: config.SEARCH_KEYWORD_TOP_K,
      min_score: config.SEARCH_KEYWORD_THRESHOLD,
      _source: ["assetId"],
      query: { bool: { should: [
        { match: { content: { query, boost: 2 } } },
        ...(contextVector ? [{ match: { content: { query: context, boost: 1 } } }] : []),
        ...["events", "facets.topic", "facets.object"].map(field => ({ match: { [field]: { query: context || query, _name: field } } })),
      ], minimum_should_match: 1, filter: [filter] } },
      sort: [{ _score: "desc" }, { assetId: "asc" }],
    },
  ] as const;
  const visual = { ...bodies[1], query: { bool: { filter: [filter], minimum_should_match: 1,
    should: ["facets.person", "facets.scene"].map(field => ({ match: { [field]: { query: context || query, _name: field } } })) } } };
  const requests = [...bodies, ...(contextVector ? [{ ...bodies[0], knn: { ...bodies[0].knn, query_vector: contextVector } }] : []), visual];
  const run = async (body: object, lexical = false, playbackOnly = true) => {
    const response = await esRequest("/_search?allow_partial_search_results=false", {
      method: "POST", body: JSON.stringify(body),
    });
    const result = await response.json() as SearchHits;
    if (result.timed_out || result._shards?.failed) {
      throw new AppError("storage_error", "Elasticsearch 检索超时或分片失败。", 503);
    }
    if (result.hits.hits.some(hit => typeof hit._score !== "number" || !Number.isFinite(hit._score))) {
      throw new AppError("storage_error", "Elasticsearch 返回无效检索分数。", 503);
    }
    const allowed = new Set(assetIds);
    return result.hits.hits
      .filter((hit) => allowed.has(hit._source.assetId))
      .map((hit): ChunkHit & { score: number } => ({
        chunkId: hit._id, assetId: hit._source.assetId, content: hit._source.content,
        score: lexical ? hit._score : 2 * hit._score - 1,
        ...(lexical ? { matchedFields: hit.matched_queries ?? [] } : { evidence: { kind: hit._source.evidenceKind ?? "unknown",
          ...(hit._source.startMs === undefined ? {} : { startMs: hit._source.startMs }),
          ...(hit._source.endMs === undefined ? {} : { endMs: hit._source.endMs }) } }),
      })).filter(hit => lexical || !playbackOnly || options.playbackDurationMs === undefined || evidenceInWindow(hit.evidence!, options.playbackDurationMs));
  };
  const responses = await Promise.all(requests.map((body, route) => run(body, route === 1 || route === requests.length - 1)));
  const results = [responses[0], responses[1], contextVector ? responses[2] : [], responses.at(-1)!];
  // 对两路候选的有限并集补齐原始分数，既能评估语境，也能阻止关键词绕过语义门槛。
  const candidateIds = [...new Set(results.flatMap(hits => hits.map(hit => hit.assetId)))];
  await Promise.all([vector, contextVector].map(async (queryVector, index) => {
    if (!queryVector) return;
    const route = index === 0 ? 0 : 2;
    const scored = new Set(results[route].map(hit => hit.assetId));
    const missing = candidateIds.filter(id => !scored.has(id));
    if (!missing.length) return;
    const supplemental = await run({ size: missing.length, _source: source, collapse: { field: "assetId" },
      query: { script_score: { query: { bool: { filter: [{ terms: { assetId: missing } }, { exists: { field: "embedding" } }, ...window] } },
        script: { source: "(cosineSimilarity(params.vector, 'embedding') + 1.0) / 2.0", params: { vector: queryVector } } } } });
    results[route].push(...supplemental.filter(hit => missing.includes(hit.assetId)));
  }));
  // 复用查询向量，对有限候选的已有整片向量校验，不增加模型调用或修改索引。
  const sceneHits = candidateIds.length ? await run({ size: candidateIds.length, _source: source, collapse: { field: "assetId" },
    query: { script_score: { query: { bool: { filter: [{ terms: { assetId: candidateIds } }, { terms: { evidenceKind: ["summary", "static", "unknown"] } }, { exists: { field: "embedding" } }] } },
      script: { source: "(Math.max(cosineSimilarity(params.vector, 'embedding'), cosineSimilarity(params.context, 'embedding')) + 1.0) / 2.0",
        params: { vector, context: contextVector ?? vector } } } } }, false, false) : [];
  return [...results, sceneHits.filter(hit => ["summary", "static", "unknown"].includes(hit.evidence?.kind ?? ""))];
}

export async function searchAssets(query: string, assetIds: string[], revalidate?: (assetIds: string[]) => Promise<string[]>, context?: string, options: RecallOptions = {}): Promise<SearchCandidate[]> {
  if (!assetIds.length) return [];
  const config = loadConfig();
  if (config.SEARCH_RECALL_ENGINE === "v2") return searchWithV2(query, assetIds, revalidate, context);
  const results = await recallChunks(query, assetIds, context, options);
  const candidates = fuseResults(results[0], results[1], config.SEARCH_RRF_K, results[2], config.SEARCH_SEMANTIC_THRESHOLD,
    { ...options, query, contextRequired: options.contextRequired && !!context && context.trim() !== query.trim(), visualHits: results[3], sceneHits: results[4] });
  return config.SEARCH_RERANK_ENABLED ? rerank(query, candidates) : candidates;
}
