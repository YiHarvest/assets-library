import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../src/server/config";
import { searchAssets } from "../src/server/search/elasticsearch";
import { freezeDataset, runSchema, type EvaluationRun } from "../benchmarks/search/evaluation";
import { fingerprint } from "../src/server/search/v2/fingerprint";
import { parseSearchManifest } from "../src/server/search/v2/manifest";
import { parseRecallPolicy } from "../src/server/search/v2/policy";
import { loadSearchBuildRuntime } from "../src/server/search/v2/runtime";
import { recallAssets } from "../src/server/search/v2/recall";
import { baselineImplementationHash } from "../benchmarks/search/baseline-identity";

/** Offline shadow replay with its own single request worker. This never runs inside
 * an HTTP handler or changes live reads, aliases, indices, source rows or jobs. */
async function main() {
  const { values } = parseArgs({ options: { dataset: { type: "string" }, manifest: { type: "string" }, policy: { type: "string" },
    system: { type: "string", default: "v2-hybrid" }, output: { type: "string" }, hardware: { type: "string" },
    "base-index": { type: "string" }, "v1-index": { type: "string" }, "max-queries": { type: "string", default: "20" }, "interval-ms": { type: "string", default: "250" } } });
  if (!values.dataset || !values.manifest || !values.policy || !values.output || !values.hardware || !values["base-index"]) {
    throw new Error("Usage: shadow-recall --dataset FILE --manifest FILE --policy FILE --hardware LABEL --base-index NAME --output NEW_FILE [--system v1|v2-hybrid|v2-semantic|v2-lexical|v2-no-metadata] [--max-queries 20] [--interval-ms 250]");
  }
  const maximum = Number(values["max-queries"]), interval = Number(values["interval-ms"]);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000 || !Number.isInteger(interval) || interval < 0 || interval > 60000) throw new Error("Invalid shadow request budget");
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const { data, hash: datasetHash } = freezeDataset(await read(values.dataset));
  const manifest = parseSearchManifest(await read(values.manifest));
  if (manifest.evaluationSourceSnapshotHash && manifest.evaluationSourceSnapshotHash !== data.sourceSnapshotHash) throw new Error("Query dataset and evaluation index use different source snapshots");
  const policy = parseRecallPolicy(await read(values.policy));
  const system = runSchema.shape.system.parse(values.system);
  if ((system === "v2-old-chunks") !== (manifest.chunker.version === "legacy-v1")) throw new Error("Ablation label does not match the manifest's actual chunker");
  const config = loadConfig();
  if (config.ELASTICSEARCH_INDEX !== values["base-index"] || !manifest.physicalIndex.startsWith(`${values["base-index"]}_recall_v2_`)) throw new Error("Shadow target differs from explicit environment index");
  if (system === "v1" && config.SEARCH_RECALL_ENGINE !== "v1") throw new Error("v1 replay requires SEARCH_RECALL_ENGINE=v1");
  if (system === "v2-hybrid" && (!policy.vectorEnabled || !policy.lexicalEnabled)) throw new Error("Hybrid evaluation requires both routes in the frozen policy");
  const selected = { ...policy, vectorEnabled: system !== "v2-lexical", lexicalEnabled: system !== "v2-semantic", includeMetadata: system !== "v2-no-metadata" && policy.includeMetadata };
  const runtime = await loadSearchBuildRuntime(manifest);
  const verifyFrozenIndex = async (index: string) => {
    const mapping = await (await runtime.client.request(`/${index}/_mapping`)).json();
    const evaluation = mapping[index]?.mappings?._meta?.recallEvaluation;
    const settings = await (await runtime.client.request(`/${index}/_settings/index.blocks.write?flat_settings=true`)).json();
    if (!evaluation?.complete || !evaluation.fullSnapshot || evaluation.sourceSnapshotHash !== data.sourceSnapshotHash ||
      settings[index]?.settings?.["index.blocks.write"] !== "true") throw new Error("Evaluation index is incomplete or not write-blocked");
    const count = await (await runtime.client.request(`/${index}/_count`)).json();
    const expected = index.includes("_recall_eval_v1_") ? evaluation.chunks : evaluation.assets;
    if (count._shards?.failed || count.count !== expected) throw new Error("Frozen index document count differs from its build receipt");
  };
  if (manifest.evaluationSourceSnapshotHash) await verifyFrozenIndex(manifest.physicalIndex);
  let baselineManifestHash: string | undefined;
  if (system === "v1") {
    const index = values["v1-index"];
    if (!index || !index.startsWith(`${values["base-index"]}_recall_eval_v1_`) || !/^[a-z0-9][a-z0-9_-]*$/.test(index)) throw new Error("v1 evaluation requires an explicit frozen baseline index");
    const mappings = await (await runtime.client.request(`/${index}/_mapping`)).json();
    const meta = mappings[index]?.mappings?._meta;
    const baseline = meta?.recallBaseline;
    if (!baseline || baseline.implementationHash !== await baselineImplementationHash() || baseline.sourceSnapshotHash !== data.sourceSnapshotHash || meta.identityHash !== fingerprint(baseline) ||
      fingerprint({ ...baseline.embedding, preprocessing: undefined }) !== fingerprint({ ...manifest.embedding, preprocessing: undefined })) throw new Error("v1 baseline snapshot or model differs");
    await verifyFrozenIndex(index);
    baselineManifestHash = meta.identityHash;
    process.env[config.APP_MODE === "prd" ? "PRD_ELASTICSEARCH_INDEX" : "DEV_ELASTICSEARCH_INDEX"] = index;
  }
  const baselinePolicy = { vectorTopK: config.SEARCH_VECTOR_TOP_K, lexicalTopK: config.SEARCH_KEYWORD_TOP_K,
    semanticThreshold: config.SEARCH_SEMANTIC_THRESHOLD, lexicalThreshold: config.SEARCH_KEYWORD_THRESHOLD,
    numCandidates: config.SEARCH_NUM_CANDIDATES, rrfK: config.SEARCH_RRF_K, rerank: config.SEARCH_RERANK_ENABLED };
  const run: EvaluationRun = { schemaVersion: 1, datasetHash, system, policyHash: fingerprint(system === "v1" ? baselinePolicy : selected),
    manifestHash: system === "v1" ? baselineManifestHash! : fingerprint(manifest),
    measurement: { hardware: values.hardware, modelFingerprint: fingerprint({ ...manifest.embedding, preprocessing: undefined }), concurrency: 1, boundary: "pinned-engine" }, results: [] };
  for (const query of data.queries.slice(0, maximum)) {
    const start = performance.now();
    try {
      const candidates = system === "v1" ? await searchAssets(query.text, query.eligibleAssetIds) :
        (await recallAssets({ query: query.text, eligibleAssetIds: query.eligibleAssetIds }, selected, async () => ({ manifest,
          tokenizer: runtime.tokenizer, embed: runtime.embed, request: runtime.client.request.bind(runtime.client) }))).candidates;
      run.results.push({ queryId: query.id, assetIds: candidates.map((candidate) => candidate.assetId), latencyMs: performance.now() - start });
    } catch {
      run.results.push({ queryId: query.id, assetIds: [], latencyMs: performance.now() - start, error: true });
    }
    if (run.results.length % 10 === 0) console.log(JSON.stringify({ completed: run.results.length, system, errors: run.results.filter((result) => result.error).length }));
    if (interval) await setTimeout(interval);
  }
  await writeFile(values.output, `${JSON.stringify(runSchema.parse(run), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ datasetHash, system, queries: run.results.length, totalFrozenQueries: data.queries.length,
    complete: run.results.length === data.queries.length, errors: run.results.filter((result) => result.error).length }));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Shadow replay failed; check configuration and frozen artifacts.");
  process.exitCode = 1;
});
