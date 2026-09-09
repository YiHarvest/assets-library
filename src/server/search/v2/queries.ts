import type { RecallPolicy } from "./policy";

const evidence = { name: "evidence", size: 1, _source: ["chunks.chunkId", "chunks.text", "chunks.sourceRefs"] };

export function vectorQuery(vector: number[], assetIds: string[], window: number, policy: RecallPolicy) {
  return { size: window, _source: ["assetId"], track_total_hits: false,
    sort: [{ _score: "desc" }, { assetId: "asc" }],
    knn: { field: "chunks.embedding", query_vector: vector, k: window, num_candidates: Math.max(window, policy.numCandidates),
      similarity: policy.semanticThreshold, inner_hits: evidence,
      filter: { bool: { filter: [{ terms: { assetId: assetIds } }, { term: { deleted: false } }] } } } };
}

export function lexicalQuery(query: string, assetIds: string[], window: number, policy: RecallPolicy, includeOcr: boolean) {
  const should: unknown[] = [{ nested: { path: "chunks", score_mode: "max", inner_hits: evidence,
    query: { match: { "chunks.text": { query, minimum_should_match: policy.lexicalMinimumShouldMatch, _name: "chunk_text" } } } } }];
  if (policy.includeMetadata) {
    const fields = (["name", "humanTags", "modelTags", "topics"] as const)
      .filter((field) => policy.weights[field] > 0).map((field) => `${field}^${policy.weights[field]}`);
    if (fields.length) should.push({ multi_match: { query, fields, type: "best_fields", minimum_should_match: policy.lexicalMinimumShouldMatch, _name: "metadata" } });
    for (const [field, weight, name] of [["exactName", policy.weights.exactName, "exact_name"],
      ["humanTags.exact", policy.weights.exactHumanTags, "exact_human_tag"], ["modelTags.exact", policy.weights.exactModelTags, "exact_model_tag"],
      ["topics.exact", policy.weights.exactTopics, "exact_topic"]] as const) {
      if (weight > 0) should.push({ term: { [field]: { value: query.toLowerCase(), boost: weight, _name: name } } });
    }
  }
  if (includeOcr) should.push({ match: { ocr: { query, minimum_should_match: policy.lexicalMinimumShouldMatch, _name: "ocr" } } });
  return { size: window, _source: ["assetId"], track_total_hits: false, min_score: policy.lexicalMinScore,
    query: { bool: { filter: [{ terms: { assetId: assetIds } }, { term: { deleted: false } }], should, minimum_should_match: 1 } },
    sort: [{ _score: "desc" }, { assetId: "asc" }] };
}
