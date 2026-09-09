import { z } from "zod";
import { fingerprint } from "../../src/server/search/v2/fingerprint";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const partition = z.enum(["train", "tune", "test"]);
export const datasetSchema = z.object({
  schemaVersion: z.literal(1), frozenAt: z.string().datetime(), provenance: z.enum(["business", "synthetic"]),
  sourceSnapshotHash: hash,
  assets: z.array(z.object({ assetId: id, sourceGroup: id, partition }).strict()).min(1),
  queries: z.array(z.object({
    id, text: z.string().trim().min(1), entry: z.enum(["assets-query", "segment-match"]), group: id,
    partition, eligibleAssetIds: z.array(id),
    noMatch: z.boolean().nullable(), poolComplete: z.boolean(),
    focus: z.enum(["name-only", "human-tag-only"]).optional(),
    judgments: z.array(z.object({ assetId: id, grade: z.number().int().min(0).max(2),
      visualReviewed: z.boolean(), descriptionContainsEvidence: z.boolean().nullable() }).strict()),
  }).strict()).min(1),
}).strict();
export type EvaluationDataset = z.infer<typeof datasetSchema>;
export const runSchema = z.object({
  schemaVersion: z.literal(1), datasetHash: hash,
  system: z.enum(["v1", "v2-semantic", "v2-lexical", "v2-hybrid", "v2-no-metadata", "v2-old-chunks"]),
  policyHash: hash, manifestHash: hash,
  measurement: z.object({ hardware: id, modelFingerprint: hash, concurrency: z.number().int().positive(),
    boundary: z.enum(["pinned-engine", "shared-recall"]).optional() }).strict(),
  results: z.array(z.object({ queryId: id, assetIds: z.array(id), latencyMs: z.number().finite().nonnegative(), error: z.boolean().optional() }).strict()),
}).strict();
export type EvaluationRun = z.infer<typeof runSchema>;

function unique(values: string[], name: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`);
}
export function freezeDataset(input: unknown) {
  const data = datasetSchema.parse(input);
  unique(data.assets.map((asset) => asset.assetId), "asset");
  unique(data.queries.map((query) => query.id), "query");
  const assets = new Map(data.assets.map((asset) => [asset.assetId, asset]));
  const partitions = new Map<string, string>();
  const assign = (key: string, partition: string) => {
    if (partitions.has(key) && partitions.get(key) !== partition) throw new Error(`Topic or source group crosses partitions: ${key}`);
    partitions.set(key, partition);
  };
  for (const asset of data.assets) assign(`source group:${asset.sourceGroup}`, asset.partition);
  for (const query of data.queries) {
    assign(`topic:${query.group}`, query.partition);
    unique(query.eligibleAssetIds, "eligible asset");
    unique(query.judgments.map((judgment) => judgment.assetId), "judgment");
    const allowed = new Set(query.eligibleAssetIds);
    if (query.eligibleAssetIds.some((assetId) => !assets.has(assetId))) throw new Error("Eligible asset absent from frozen corpus");
    if (query.eligibleAssetIds.some((assetId) => assets.get(assetId)!.partition !== query.partition)) throw new Error("Eligible source group crosses partitions");
    for (const judgment of query.judgments) {
      if (!allowed.has(judgment.assetId)) throw new Error("Judgment outside query scope");
      if (judgment.grade > 0) {
        if (query.noMatch === true) throw new Error("No-match query has a relevant judgment");
        assign(`source group:${assets.get(judgment.assetId)!.sourceGroup}`, query.partition);
      }
    }
  }
  return { data, hash: fingerprint(data) };
}

const mean = (values: Array<number | null>) => {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const percentile95 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
function wilson(successes: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054, fraction = successes / total, denominator = 1 + z * z / total;
  const center = (fraction + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt(fraction * (1 - fraction) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function measure(data: EvaluationDataset, input: EvaluationRun, datasetHash: string) {
  const run = runSchema.parse(input);
  if (run.datasetHash !== datasetHash) throw new Error("Run does not match frozen dataset");
  unique(run.results.map((result) => result.queryId), "run query");
  const knownQueries = new Set(data.queries.map((query) => query.id));
  if (run.results.some((result) => !knownQueries.has(result.queryId))) throw new Error("Run contains unknown query");
  const results = new Map(run.results.map((result) => [result.queryId, result]));
  let scopeViolations = 0, errors = 0, duplicates = 0, incompleteQueries = 0, metadataFailures = 0;
  const rows = data.queries.filter((query) => query.partition === "test").map((query) => {
    const result = results.get(query.id);
    if (!result) throw new Error("Run is missing a frozen test query");
    const allowed = new Set(query.eligibleAssetIds);
    scopeViolations += result.assetIds.filter((assetId) => !allowed.has(assetId)).length;
    duplicates += result.assetIds.length - new Set(result.assetIds).size;
    if (result.error) errors++;
    const ranked = [...new Set(result.assetIds)];
    const judgments = new Map(query.judgments.filter((judgment) => judgment.visualReviewed).map((judgment) => [judgment.assetId, judgment.grade]));
    const positives = [...judgments.values()].filter((grade) => grade > 0).length;
    const positive = query.noMatch === false && positives > 0;
    const negative = query.noMatch === true && query.poolComplete;
    const allJudged = (ids: string[]) => ids.every((assetId) => judgments.has(assetId));
    const complete = query.poolComplete && (positive || negative) && query.judgments.every((judgment) => judgment.visualReviewed) &&
      (negative || allJudged(ranked.slice(0, 100)));
    if (!complete) incompleteQueries++;
    const recall = (k: number) => positive ? ranked.slice(0, k).filter((assetId) => (judgments.get(assetId) ?? 0) > 0).length / positives : null;
    const top = ranked.slice(0, 10);
    const dcg = (grades: number[]) => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
    const ideal = dcg([...judgments.values()].sort((a, b) => b - a).slice(0, 10));
    const first = ranked.findIndex((assetId) => (judgments.get(assetId) ?? 0) > 0);
    const mrr = positive && allJudged(first < 0 ? ranked : ranked.slice(0, first + 1)) ? (first < 0 ? 0 : 1 / (first + 1)) : null;
    if (query.focus && (!positive || !ranked.slice(0, 100).some((assetId) => (judgments.get(assetId) ?? 0) > 0))) metadataFailures++;
    return { entry: query.entry, positive, negative: negative && allowed.size > 0, recall20: recall(20), recall50: recall(50), recall100: recall(100),
      success20: positive ? Number(recall(20)! > 0) : null,
      precision10: positive && allJudged(top) ? top.filter((assetId) => (judgments.get(assetId) ?? 0) > 0).length / 10 : null,
      ndcg10: positive && allJudged(top) ? dcg(top.map((assetId) => judgments.get(assetId)!)) / ideal : null,
      mrr, falseRecall: negative && allowed.size > 0 ? Number(ranked.length > 0) : null, latencyMs: result.latencyMs };
  });
  const aggregate = (selected: typeof rows) => {
    const negatives = selected.filter((row) => row.negative);
    return { queries: selected.length, positiveQueries: selected.filter((row) => row.positive).length, negativeQueries: negatives.length,
      recall20: mean(selected.map((row) => row.recall20)), recall50: mean(selected.map((row) => row.recall50)),
      recall100: mean(selected.map((row) => row.recall100)), success20: mean(selected.map((row) => row.success20)),
      precision10: mean(selected.map((row) => row.precision10)), ndcg10: mean(selected.map((row) => row.ndcg10)), mrr: mean(selected.map((row) => row.mrr)),
      falseRecallRate: mean(selected.map((row) => row.falseRecall)),
      falseRecallInterval95: wilson(negatives.reduce((sum, row) => sum + row.falseRecall!, 0), negatives.length),
      p95Ms: percentile95(selected.map((row) => row.latencyMs)) };
  };
  return { overall: aggregate(rows), groups: { "assets-query": aggregate(rows.filter((row) => row.entry === "assets-query")),
    "segment-match": aggregate(rows.filter((row) => row.entry === "segment-match")) },
    scopeViolations, errors, duplicates, incompleteQueries, metadataFailures };
}

/** Provisional plan gates, deliberately conservative. These are not a production SLA.
 * Recall denominators contain visually judged relevant assets, not all true positives. */
export function evaluateRecall(input: unknown, baselineRun: EvaluationRun, candidateRun: EvaluationRun) {
  const { data, hash: datasetHash } = freezeDataset(input);
  if (baselineRun.system !== "v1" || candidateRun.system !== "v2-hybrid") throw new Error("Cutover comparison requires v1 and v2-hybrid");
  const baseline = measure(data, baselineRun, datasetHash), candidate = measure(data, candidateRun, datasetHash);
  const blockers: string[] = [];
  if (data.provenance !== "business") blockers.push("synthetic_dataset");
  if (candidate.overall.queries < 200) blockers.push("insufficient_test_queries");
  if (data.assets.length < 500) blockers.push("insufficient_assets");
  if (candidate.overall.negativeQueries < 20) blockers.push("insufficient_negative_queries");
  if (baseline.incompleteQueries || candidate.incompleteQueries) blockers.push("unjudged_or_incomplete_pool");
  if (baseline.scopeViolations || candidate.scopeViolations) blockers.push("scope_violation");
  if (baseline.errors || candidate.errors) blockers.push("retrieval_error");
  if (baseline.duplicates || candidate.duplicates) blockers.push("duplicate_asset_results");
  if (candidate.metadataFailures || !data.queries.some((query) => query.partition === "test" && query.focus === "name-only") ||
    !data.queries.some((query) => query.partition === "test" && query.focus === "human-tag-only")) blockers.push("metadata_suite_incomplete_or_failed");
  if (candidate.overall.recall50 === null || candidate.overall.recall50 < 0.95) blockers.push("recall50_below_target");
  for (const [group, current, previous] of [
    ["overall", candidate.overall, baseline.overall],
    ["assets-query", candidate.groups["assets-query"], baseline.groups["assets-query"]],
    ["segment-match", candidate.groups["segment-match"], baseline.groups["segment-match"]],
  ] as const) {
    for (const metric of ["recall50", "precision10", "ndcg10", "mrr"] as const) {
      if (current[metric] === null || previous[metric] === null || current[metric]! + 1e-12 < previous[metric]!) blockers.push(`${group}_${metric}_regression_or_missing`);
    }
  }
  if (candidate.overall.falseRecallRate === null || baseline.overall.falseRecallRate === null ||
    candidate.overall.falseRecallRate > 0.05 || candidate.overall.falseRecallRate > baseline.overall.falseRecallRate) blockers.push("false_recall_above_target");
  if (fingerprint(baselineRun.measurement) !== fingerprint(candidateRun.measurement)) blockers.push("unmatched_performance_conditions");
  if (baselineRun.measurement.boundary !== "shared-recall" || candidateRun.measurement.boundary !== "shared-recall") blockers.push("shared_recall_latency_missing");
  if (candidate.overall.p95Ms === null || baseline.overall.p95Ms === null || candidate.overall.p95Ms > 1.2 * baseline.overall.p95Ms) blockers.push("latency_above_target");
  return { schemaVersion: 1 as const, evaluatedAt: new Date().toISOString(), datasetHash,
    baselineRunHash: fingerprint(baselineRun), candidateRunHash: fingerprint(candidateRun),
    candidatePolicyHash: candidateRun.policyHash, candidateManifestHash: candidateRun.manifestHash,
    baseline, candidate, eligibleForCutover: blockers.length === 0, blockers,
    limitations: ["Recall is measured against the visually judged pool; unknown relevant assets can inflate recall.",
      "False-recall confidence intervals assume independent queries; grouped queries can increase uncertainty.",
      "This report alone does not prove index catch-up, source freshness, ablation completeness or deployment readiness."] };
}

/** A review queue, never automatic negative labels. Results include all systems' union. */
export function judgingPool(input: unknown, runs: EvaluationRun[]) {
  const { data, hash: datasetHash } = freezeDataset(input);
  const knownQueries = new Set(data.queries.map((query) => query.id));
  for (const run of runs) {
    runSchema.parse(run);
    if (run.datasetHash !== datasetHash) throw new Error("Run does not match frozen dataset");
    unique(run.results.map((result) => result.queryId), "run query");
    if (run.results.some((result) => !knownQueries.has(result.queryId))) throw new Error("Run contains unknown query");
  }
  return { datasetHash, queries: data.queries.map((query) => {
    const ids = new Set(query.judgments.map((judgment) => judgment.assetId));
    const allowed = new Set(query.eligibleAssetIds);
    for (const run of runs) for (const assetId of run.results.find((result) => result.queryId === query.id)?.assetIds ?? []) {
      if (!allowed.has(assetId)) throw new Error("Cannot export a candidate outside query scope");
      ids.add(assetId);
    }
    return { queryId: query.id, query: query.text, noMatch: query.noMatch, poolComplete: false,
      replayedSystems: [...new Set(runs.filter((run) => run.results.some((result) => result.queryId === query.id && !result.error)).map((run) => run.system))].sort(),
      judgments: [...ids].sort().map((assetId) => query.judgments.find((judgment) => judgment.assetId === assetId) ??
        { assetId, grade: null, visualReviewed: false, descriptionContainsEvidence: null }) };
  }) };
}
