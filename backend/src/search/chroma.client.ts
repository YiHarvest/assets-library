import { loadConfig } from "../config";
import type { AnalysisResult } from "../analysis/analysis.types";

interface ChromaCollection { id: string; name: string }

function passages(result: AnalysisResult) {
  const tags = Object.entries(result.tags).flatMap(([category, values]) => values.map((value) => `${category} ${value}`));
  return result.kind === "image"
    ? [result.description, ...tags, result.ocr.text ?? ""].filter(Boolean)
    : [result.description, ...result.topics, ...tags, ...result.visual_segments.map((item) => item.summary), ...result.key_moments.map((item) => item.summary), ...result.timeline.map((item) => item.summary)].filter(Boolean);
}

function tokenize(text: string) {
  const terms = text.trim().match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.flatMap((term) => {
    const chars = [...term];
    return /^\p{Script=Han}+$/u.test(term) && chars.length >= 3 ? [term, ...chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join(""))] : [term];
  }).join(" ");
}

export class ChromaClient {
  private readonly config = loadConfig();
  private readonly base = `${this.config.CHROMA_URL.replace(/\/$/, "")}/api/v2/tenants/${encodeURIComponent(this.config.CHROMA_TENANT)}/databases/${encodeURIComponent(this.config.CHROMA_DATABASE)}`;

  get enabled() { return Boolean(this.config.EMBEDDING_BASE_URL && this.config.EMBEDDING_MODEL); }

  private async request<T>(path: string, init?: RequestInit) {
    const response = await fetch(`${this.base}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Chroma 请求失败：HTTP ${response.status}。`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  private async collection() {
    const current = await this.request<ChromaCollection[]>("/collections?limit=100&offset=0");
    const found = current.find((item) => item.name === this.config.CHROMA_COLLECTION);
    if (found) return found;
    try {
      return await this.request<ChromaCollection>("/collections", { method: "POST", body: JSON.stringify({ name: this.config.CHROMA_COLLECTION }) });
    } catch (error) {
      const refreshed = await this.request<ChromaCollection[]>("/collections?limit=100&offset=0");
      const created = refreshed.find((item) => item.name === this.config.CHROMA_COLLECTION);
      if (created) return created;
      throw error;
    }
  }

  private async embed(texts: string[]) {
    if (!this.enabled) return [];
    const response = await fetch(`${this.config.EMBEDDING_BASE_URL!.replace(/\/$/, "")}/embeddings`, {
      method: "POST", headers: { "content-type": "application/json", ...(this.config.EMBEDDING_API_KEY ? { authorization: `Bearer ${this.config.EMBEDDING_API_KEY}` } : {}) },
      body: JSON.stringify({ model: this.config.EMBEDDING_MODEL, input: texts }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Embedding 服务返回 HTTP ${response.status}。`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const vectors = payload.data?.map((item) => item.embedding);
    if (!vectors || vectors.length !== texts.length || vectors.some((vector) => !vector?.length)) throw new Error("Embedding 服务返回无效向量。");
    return vectors as number[][];
  }

  async index(assetId: string, analysis: AnalysisResult) {
    if (!this.enabled) return;
    const documents = passages(analysis).map(tokenize).filter(Boolean);
    if (!documents.length) return;
    const vectors = await this.embed(documents);
    const collection = await this.collection();
    await this.request(`/collections/${encodeURIComponent(collection.id)}/delete`, { method: "POST", body: JSON.stringify({ where: { assetId } }) });
    await this.request(`/collections/${encodeURIComponent(collection.id)}/upsert`, { method: "POST", body: JSON.stringify({
      ids: documents.map((_, index) => `${assetId}:${index}`), documents, embeddings: vectors,
      metadatas: documents.map((_, index) => ({ assetId, chunk: index })),
    }) });
  }

  async delete(assetId: string) {
    if (!this.enabled) return;
    const collection = await this.collection();
    await this.request(`/collections/${encodeURIComponent(collection.id)}/delete`, { method: "POST", body: JSON.stringify({ where: { assetId } }) });
  }

  async search(query: string, limit: number, assetIds?: string[]) {
    const scores = new Map<string, number>();
    if (!this.enabled || assetIds?.length === 0) return scores;
    const [vector] = await this.embed([tokenize(query)]);
    const collection = await this.collection();
    const result = await this.request<{ distances?: Array<Array<number | null>>; metadatas?: Array<Array<{ assetId?: string } | null>> }>(`/collections/${encodeURIComponent(collection.id)}/query`, {
      method: "POST", body: JSON.stringify({ query_embeddings: [vector], n_results: Math.min(Math.max(limit, 1), 1000), include: ["metadatas", "distances"], ...(assetIds ? { where: { assetId: { $in: assetIds } } } : {}) }),
    });
    for (const [index, metadata] of (result.metadatas?.[0] ?? []).entries()) {
      const id = metadata?.assetId; const distance = result.distances?.[0]?.[index];
      if (!id || distance === null || distance === undefined) continue;
      const score = 1 / (1 + distance);
      if (score > 0.45) scores.set(id, Math.max(scores.get(id) ?? 0, score));
    }
    return scores;
  }
}

