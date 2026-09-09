import type { SearchCandidate } from "@/server/search/elasticsearch";
import type { SourceRef } from "./types";
import { compareText } from "./fingerprint";

export interface AssetRouteHit {
  assetId: string;
  score: number;
  chunkId?: string;
  text?: string;
  sourceRefs?: SourceRef[];
  matchedFields?: string[];
}
export interface RouteEvidence extends Omit<AssetRouteHit, "score" | "assetId"> { rank: number; rawScore: number }
export interface RecallCandidate extends SearchCandidate {
  evidence: { vector?: RouteEvidence; lexical?: RouteEvidence };
}

export function fuseAssetResults(vector: AssetRouteHit[], lexical: AssetRouteHit[], k: number): RecallCandidate[] {
  const assets = new Map<string, RecallCandidate>();
  for (const [hits, route, field] of [[vector, "vector", "semanticScore"], [lexical, "lexical", "keywordScore"]] as const) {
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.assetId)) continue;
      seen.add(hit.assetId);
      const rank = seen.size;
      const contribution = (k + 1) / (2 * (k + rank));
      const candidate = assets.get(hit.assetId) ?? { assetId: hit.assetId, searchScore: 0, evidence: {} };
      candidate[field] = contribution;
      candidate.searchScore += contribution;
      candidate.evidence[route] = { rank, rawScore: hit.score,
        ...(hit.chunkId === undefined ? {} : { chunkId: hit.chunkId }),
        ...(hit.text === undefined ? {} : { text: hit.text }),
        ...(hit.sourceRefs === undefined ? {} : { sourceRefs: hit.sourceRefs }),
        ...(hit.matchedFields === undefined ? {} : { matchedFields: hit.matchedFields }) };
      assets.set(hit.assetId, candidate);
    }
  }
  return [...assets.values()].sort((a, b) => b.searchScore - a.searchScore || compareText(a.assetId, b.assetId));
}
