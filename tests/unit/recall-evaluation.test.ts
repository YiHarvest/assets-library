import { describe, expect, it } from "vitest";
import { evaluateRecall, freezeDataset, judgingPool, type EvaluationDataset, type EvaluationRun } from "../../benchmarks/search/evaluation";

const dataset = (): EvaluationDataset => ({ schemaVersion: 1, frozenAt: "2026-09-09T00:00:00.000Z", provenance: "business",
  sourceSnapshotHash: "a".repeat(64), assets: ["a", "b", "c"].map((assetId) => ({ assetId, sourceGroup: assetId, partition: "test" })),
  queries: [
    { id: "positive", text: "海边", entry: "assets-query", group: "beach", partition: "test", eligibleAssetIds: ["a", "b", "c"],
      noMatch: false, poolComplete: true, judgments: [{ assetId: "a", grade: 2, visualReviewed: true, descriptionContainsEvidence: true },
        { assetId: "b", grade: 1, visualReviewed: true, descriptionContainsEvidence: false },
        { assetId: "c", grade: 0, visualReviewed: true, descriptionContainsEvidence: true }] },
    { id: "negative", text: "火星", entry: "segment-match", group: "mars", partition: "test", eligibleAssetIds: ["a", "b", "c"],
      noMatch: true, poolComplete: true, judgments: [] },
  ] });
function run(data: EvaluationDataset, system: EvaluationRun["system"], ids = ["c", "a"]) : EvaluationRun {
  return { schemaVersion: 1, datasetHash: freezeDataset(data).hash, system, policyHash: "b".repeat(64), manifestHash: "c".repeat(64),
    measurement: { hardware: "isolated-test", modelFingerprint: "d".repeat(64), concurrency: 1 },
    results: [{ queryId: "positive", assetIds: ids, latencyMs: 10 }, { queryId: "negative", assetIds: [], latencyMs: 20 }] };
}
describe("frozen recall evaluation", () => {
  it("keeps pending candidates unlabeled and exposes replay coverage per query", () => {
    const data = dataset();
    data.queries[0].judgments = data.queries[0].judgments.filter((judgment) => judgment.assetId !== "c");
    const partial = run(data, "v2-hybrid"); partial.results.pop();
    const pool = judgingPool(data, [partial]);
    expect(pool.queries[0].replayedSystems).toEqual(["v2-hybrid"]);
    expect(pool.queries[1].replayedSystems).toEqual([]);
    expect(pool.queries[0].judgments.find((judgment) => judgment.assetId === "c")).toMatchObject({ grade: null, visualReviewed: false });
    expect(pool.queries[0].poolComplete).toBe(false);
  });
  it("computes asset-level judged metrics, entry groups and negative-query uncertainty", () => {
    const data = dataset();
    const result = evaluateRecall(data, run(data, "v1"), run(data, "v2-hybrid"));
    expect(result.candidate.overall).toMatchObject({ queries: 2, positiveQueries: 1, negativeQueries: 1,
      recall20: 0.5, recall50: 0.5, recall100: 0.5, success20: 1, precision10: 0.1, mrr: 0.5, falseRecallRate: 0, p95Ms: 20 });
    expect(result.candidate.groups["assets-query"].recall50).toBe(0.5);
    expect(result.candidate.overall.falseRecallInterval95?.[1]).toBeGreaterThan(0.7);
    expect(result.eligibleForCutover).toBe(false);
    expect(result.blockers).toContain("insufficient_test_queries");
  });
  it("never treats unjudged candidates as negatives and rejects scope leaks, errors and unreviewed evidence", () => {
    const data = dataset();
    data.queries[0].judgments = data.queries[0].judgments.filter((j) => j.assetId !== "c");
    data.queries[0].poolComplete = false;
    const candidate = run(data, "v2-hybrid", ["c", "a", "outside"]);
    candidate.results[1].error = true;
    const result = evaluateRecall(data, run(data, "v1"), candidate);
    expect(result.candidate.overall.precision10).toBeNull();
    expect(result.candidate.overall.ndcg10).toBeNull();
    expect(result.candidate.overall.mrr).toBeNull();
    expect(result.candidate.scopeViolations).toBe(1);
    expect(result.candidate.errors).toBe(1);
    expect(result.blockers).toEqual(expect.arrayContaining(["unjudged_or_incomplete_pool", "scope_violation", "retrieval_error"]));
  });
  it("binds runs to the frozen corpus, prevents topic/video leakage, and requires matched performance conditions", () => {
    const data = dataset();
    const old = run(data, "v1");
    data.queries[0].text = "changed";
    expect(() => evaluateRecall(data, old, run(data, "v2-hybrid"))).toThrow(/dataset/);
    const copy = structuredClone(data.queries[0]);
    data.queries.push({ ...copy, id: "leaked", group: "different-topic", partition: "tune" });
    expect(() => freezeDataset(data)).toThrow(/source group/);
    data.queries.pop();
    const candidate = run(data, "v2-hybrid");
    candidate.measurement.concurrency = 2;
    expect(evaluateRecall(data, run(data, "v1"), candidate).blockers).toContain("unmatched_performance_conditions");
  });
  it("requires measured shared recall latency before cutover, even when engine timings match", () => {
    const data = dataset(), baseline = run(data, "v1"), candidate = run(data, "v2-hybrid");
    expect(evaluateRecall(data, baseline, candidate).blockers).toContain("shared_recall_latency_missing");
    Object.assign(baseline.measurement, { boundary: "pinned-engine" });
    Object.assign(candidate.measurement, { boundary: "pinned-engine" });
    expect(evaluateRecall(data, baseline, candidate).blockers).toContain("shared_recall_latency_missing");
    Object.assign(baseline.measurement, { boundary: "shared-recall" });
    Object.assign(candidate.measurement, { boundary: "shared-recall" });
    expect(evaluateRecall(data, baseline, candidate).blockers).not.toContain("shared_recall_latency_missing");
  });
  it("does not count an empty allowed scope as a judged negative quality sample", () => {
    const data = dataset();
    data.queries[1].eligibleAssetIds = [];
    const result = evaluateRecall(data, run(data, "v1"), run(data, "v2-hybrid"));
    expect(result.candidate.overall.negativeQueries).toBe(0);
    expect(result.candidate.overall.falseRecallRate).toBeNull();
    expect(result.candidate.incompleteQueries).toBe(0);
    expect(result.blockers).toContain("insufficient_negative_queries");
  });
});
