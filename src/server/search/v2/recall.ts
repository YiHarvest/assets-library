import { AppError } from "@/server/errors";
import { hashText, normalizeSearchText } from "./fingerprint";
import type { SearchBuildManifest, SourceRef, TextTokenizer } from "./types";
import type { EmbedSearchTexts } from "./writer";
import { fuseAssetResults, type AssetRouteHit, type RecallCandidate } from "./fusion";
import type { RecallPolicy } from "./policy";
import { lexicalQuery, vectorQuery } from "./queries";

export interface RecallDependencies {
  manifest: SearchBuildManifest;
  embed: EmbedSearchTexts;
  tokenizer: TextTokenizer;
  request(path: string, init: RequestInit): Promise<Response>;
}
export interface RecallRequest { query: string; context?: string; eligibleAssetIds: string[] }

export interface RecallDiagnostics {
  queryHash: string; policyVersion: string; allowedAssets: number; physicalIndex: string | null; buildId: string | null;
  vectorAssets: number; lexicalAssets: number; fusedAssets: number; discardedAssets: number; expansions: number;
  windowFull: boolean; embeddingMs: number; vectorMs: number; lexicalMs: number; revalidationMs: number; totalMs: number;
}
interface SearchHit {
  _score: number;
  _source: { assetId: string };
  matched_queries?: string[];
  inner_hits?: { evidence?: { hits: { hits: Array<{ _source: { chunkId: string; text: string; sourceRefs: SourceRef[] } }> } } };
}

export async function recallAssets(request: RecallRequest, policy: RecallPolicy, resolve: () => Promise<RecallDependencies>,
  revalidate?: (assetIds: string[]) => Promise<string[]>) {
  const started = performance.now();
  const query = normalizeSearchText(request.query);
  const context = normalizeSearchText(request.context ?? "");
  const eligible = [...new Set(request.eligibleAssetIds)];
  if (eligible.length > policy.maxEligibleIds) throw new AppError("invalid_request", "候选素材范围超过召回容量上限。", 422);
  const empty: RecallCandidate[] = [];
  const diagnostics: RecallDiagnostics = { queryHash: hashText(context ? JSON.stringify([query, context]) : query), policyVersion: policy.version, allowedAssets: eligible.length,
    physicalIndex: null, buildId: null, vectorAssets: 0, lexicalAssets: 0, fusedAssets: 0, discardedAssets: 0, expansions: 0,
    windowFull: false, embeddingMs: 0, vectorMs: 0, lexicalMs: 0, revalidationMs: 0, totalMs: 0 };
  if (!eligible.length || !query) return { candidates: empty, diagnostics };
  const dependencies = await resolve();
  diagnostics.physicalIndex = dependencies.manifest.physicalIndex;
  diagnostics.buildId = dependencies.manifest.buildId;
  const embeddingStarted = performance.now();
  const texts = context && context !== query ? [query, context] : [query];
  const [focusVector, contextVector] = policy.vectorEnabled
    ? await dependencies.embed(texts.map((text) => ({ text, tokenCount: dependencies.tokenizer.count(text) }))) : [];
  // Keep the focus explicit: a long surrounding sentence must not replace it.
  const blended = contextVector ? focusVector.map((value, i) => 0.7 * value + 0.3 * contextVector[i]) : focusVector;
  const norm = blended ? Math.hypot(...blended) : 0;
  const vector = norm ? blended.map((value) => value / norm) : focusVector;
  diagnostics.embeddingMs = performance.now() - embeddingStarted;
  const route = async (body: unknown, name: "vector" | "lexical", ids: string[]): Promise<AssetRouteHit[]> => {
    const allowed = new Set(ids);
    const tick = performance.now();
    const response = await dependencies.request(`/${encodeURIComponent(dependencies.manifest.physicalIndex)}/_search?allow_partial_search_results=false`, {
      method: "POST", body: JSON.stringify(body),
    });
    const result = await response.json();
    if (result.timed_out || result._shards?.failed || !Array.isArray(result.hits?.hits)) {
      throw new AppError("storage_error", "Elasticsearch 检索超时、分片失败或返回格式无效。", 503);
    }
    const hits = (result.hits.hits as SearchHit[]).filter((hit) => allowed.has(hit._source?.assetId)).map((hit) => {
      if (!Number.isFinite(hit._score)) throw new AppError("storage_error", "Elasticsearch 返回无效检索分数。", 503);
      const evidence = hit.inner_hits?.evidence?.hits.hits[0]?._source;
      return { assetId: hit._source.assetId, score: name === "vector" ? 2 * hit._score - 1 : hit._score,
        ...(evidence ? { chunkId: evidence.chunkId, text: evidence.text, sourceRefs: evidence.sourceRefs } : {}),
        ...(hit.matched_queries ? { matchedFields: hit.matched_queries } : {}) };
    });
    diagnostics[name === "vector" ? "vectorMs" : "lexicalMs"] += performance.now() - tick;
    return hits;
  };
  const run = async (ids: string[], vectorWindow: number, lexicalWindow: number) => {
    let [vectorHits, lexicalHits] = await Promise.all([
      policy.vectorEnabled ? route(vectorQuery(vector, ids, vectorWindow, policy), "vector", ids) : [],
      policy.lexicalEnabled ? route(lexicalQuery(query, ids, lexicalWindow, policy, dependencies.manifest.includeOcr), "lexical", ids) : [],
    ]);
    diagnostics.windowFull = vectorHits.length >= vectorWindow || lexicalHits.length >= lexicalWindow;
    if (policy.vectorEnabled && lexicalHits.length) {
      const semanticIds = new Set(vectorHits.map((hit) => hit.assetId));
      const unchecked = [...new Set(lexicalHits.map((hit) => hit.assetId))].filter((id) => !semanticIds.has(id));
      // BM25 can add candidates outside the ANN window, but cannot bypass the
      // same semantic threshold. Score only that bounded lexical remainder.
      if (unchecked.length) vectorHits = [...vectorHits, ...await route(vectorQuery(vector, unchecked, unchecked.length, policy), "vector", unchecked)]
        .sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId));
      vectorHits.forEach((hit) => semanticIds.add(hit.assetId));
      lexicalHits = lexicalHits.filter((hit) => semanticIds.has(hit.assetId));
    }
    if (contextVector && vectorHits.length) {
      const ids = vectorHits.map(hit => hit.assetId);
      const contextualIds = new Set((await route(vectorQuery(contextVector, ids, ids.length, policy), "vector", ids)).map(hit => hit.assetId));
      vectorHits = vectorHits.filter(hit => contextualIds.has(hit.assetId));
      lexicalHits = lexicalHits.filter(hit => contextualIds.has(hit.assetId));
    }
    const candidates = fuseAssetResults(vectorHits, lexicalHits, policy.rrfK);
    diagnostics.vectorAssets = vectorHits.length;
    diagnostics.lexicalAssets = lexicalHits.length;
    diagnostics.fusedAssets = candidates.length;
    return candidates;
  };
  const rejected = new Set<string>();
  const check = async (candidates: RecallCandidate[]) => {
    if (!revalidate || !candidates.length) return candidates;
    const tick = performance.now();
    const allowedNow = new Set(await revalidate(candidates.map((candidate) => candidate.assetId)));
    diagnostics.revalidationMs += performance.now() - tick;
    return candidates.filter((candidate) => {
      if (allowedNow.has(candidate.assetId)) return true;
      rejected.add(candidate.assetId);
      return false;
    });
  };
  let candidates = await check(await run(eligible, policy.vectorTopK, policy.lexicalTopK));
  if (rejected.size && diagnostics.windowFull && policy.expansionTopK > Math.max(policy.vectorTopK, policy.lexicalTopK)) {
    const remaining = eligible.filter((id) => !rejected.has(id));
    if (remaining.length > candidates.length) {
      diagnostics.expansions = 1;
      candidates = await check(await run(remaining, policy.expansionTopK, policy.expansionTopK));
    }
  }
  diagnostics.discardedAssets = rejected.size;
  diagnostics.totalMs = performance.now() - started;
  return { candidates, diagnostics };
}
