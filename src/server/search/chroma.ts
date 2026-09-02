import { loadConfig } from "@/server/config";
import type { AnalysisResult } from "@/shared/contracts";

type ChromaCollection = { id: string; name: string };
const semanticSimilarityThreshold = 0.45;

export interface SearchAnalysisOptions {
  /** 调用方需要最终层诊断时可传 0，默认仍保持历史阈值。 */
  minimumSimilarity?: number;
}

function chromaBaseUrl() {
  return loadConfig().CHROMA_URL.replace(/\/$/, "");
}

function chromaDatabasePath() {
  const config = loadConfig();
  return `${chromaBaseUrl()}/api/v2/tenants/${encodeURIComponent(config.CHROMA_TENANT)}/databases/${encodeURIComponent(config.CHROMA_DATABASE)}`;
}

async function chromaRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${chromaDatabasePath()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`Chroma 请求失败：HTTP ${response.status}。`);
  }
  return (await response.json()) as T;
}

async function collection() {
  const config = loadConfig();
  const collections = await chromaRequest<ChromaCollection[]>("/collections?limit=100&offset=0");
  const existing = collections.find((item) => item.name === config.CHROMA_COLLECTION);
  if (existing) return existing;
  try {
    return await chromaRequest<ChromaCollection>("/collections", {
      method: "POST",
      body: JSON.stringify({ name: config.CHROMA_COLLECTION }),
    });
  } catch (error) {
    const refreshed = await chromaRequest<ChromaCollection[]>("/collections?limit=100&offset=0");
    const created = refreshed.find((item) => item.name === config.CHROMA_COLLECTION);
    if (created) return created;
    throw error;
  }
}

async function embed(texts: string[]) {
  const config = loadConfig();
  if (!config.embeddingConfigured || !config.embeddingBaseUrl || !config.EMBEDDING_MODEL) {
    return [];
  }
  const response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`Embedding 服务返回 HTTP ${response.status}。`);
  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vectors = payload.data?.map((item) => item.embedding);
  if (!vectors || vectors.length !== texts.length || vectors.some((item) => !item?.length)) {
    throw new Error("Embedding 服务返回无效向量。");
  }
  return vectors as number[][];
}

function tokenize(text: string) {
  const compact = text.trim().replace(/\s+/g, " ");
  const terms = compact.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.flatMap((term) => {
    const characters = Array.from(term);
    if (!/^[\p{Script=Han}]+$/u.test(term) || characters.length < 3) return [term];
    return [term, ...characters.slice(0, -1).map((_, index) => characters.slice(index, index + 2).join(""))];
  }).join(" ");
}

function analysisPassages(result: AnalysisResult) {
  if (result.kind === "image") {
    return [
      result.description,
      ...Object.entries(result.tags).flatMap(([category, values]) => values.map((value) => `${category} ${value}`)),
      result.ocr.text ?? "",
    ].filter(Boolean);
  }
  return [
    result.description,
    ...result.topics,
    ...Object.entries(result.tags).flatMap(([category, values]) => values.map((value) => `${category} ${value}`)),
    ...result.visualSegments.map((item) => item.summary),
    ...result.keyMoments.map((item) => item.summary),
    ...result.timeline.map((item) => item.summary),
  ].filter(Boolean);
}

export function semanticSearchEnabled() {
  return loadConfig().embeddingConfigured;
}

export async function indexAnalysis(assetId: string, result: AnalysisResult) {
  const passages = analysisPassages(result).map(tokenize).filter(Boolean);
  if (!passages.length) return;
  const vectors = await embed(passages);
  if (!vectors.length) return;
  const target = await collection();
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ where: { assetId } }),
  });
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/upsert`, {
    method: "POST",
    body: JSON.stringify({
      ids: passages.map((_, index) => `${assetId}:${index}`),
      documents: passages,
      embeddings: vectors,
      metadatas: passages.map((_, index) => ({ assetId, chunk: index })),
    }),
  });
}

/** 删除素材对应的全部向量分块；未启用 embedding 时无需访问 Chroma。 */
export async function deleteAnalysis(assetId: string) {
  if (!semanticSearchEnabled()) return;
  const target = await collection();
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ where: { assetId } }),
  });
}

export async function searchAnalysis(
  query: string,
  limit: number,
  assetIds?: string[],
  options: SearchAnalysisOptions = {},
) {
  if (!semanticSearchEnabled()) return new Map<string, number>();
  if (assetIds && assetIds.length === 0) return new Map<string, number>();
  const vectors = await embed([tokenize(query)]);
  if (!vectors.length) return new Map<string, number>();
  const target = await collection();
  const result = await chromaRequest<{
    distances?: Array<Array<number | null>>;
    metadatas?: Array<Array<{ assetId?: string } | null>>;
  }>(`/collections/${encodeURIComponent(target.id)}/query`, {
    method: "POST",
    body: JSON.stringify({
      query_embeddings: vectors,
      n_results: limit,
      include: ["metadatas", "distances"],
      ...(assetIds ? { where: { assetId: { $in: assetIds } } } : {}),
    }),
  });
  const minimumSimilarity =
    Math.min(
      1,
      Math.max(0, options.minimumSimilarity ?? semanticSimilarityThreshold),
    );
  const allowedAssetIds = assetIds ? new Set(assetIds) : null;
  const scores = new Map<string, number>();
  for (const [index, metadata] of (result.metadatas?.[0] ?? []).entries()) {
    const assetId = metadata?.assetId;
    const distance = result.distances?.[0]?.[index];
    if (!assetId || distance === null || distance === undefined) continue;
    // 即使向量库错误地忽略了 where，也不能让范围外素材进入上层召回。
    if (allowedAssetIds && !allowedAssetIds.has(assetId)) continue;
    const similarity = Math.max(0, Math.min(1, 1 / (1 + distance)));
    if (similarity <= minimumSimilarity) continue;
    scores.set(
      assetId,
      Math.max(scores.get(assetId) ?? 0, similarity),
    );
  }
  return scores;
}
