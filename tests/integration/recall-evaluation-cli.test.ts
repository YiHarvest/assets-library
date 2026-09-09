import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElasticsearchClient } from "@/server/search/v2/elasticsearch";
import { fingerprint } from "@/server/search/v2/fingerprint";
import { freezeDataset, type EvaluationDataset, type EvaluationRun } from "../../benchmarks/search/evaluation";
import deployment from "../../config/recall/bge-m3-serving-identity.json";

const enabled = Boolean(process.env.TEST_RECALL_ES_URL && process.env.TEST_RECALL_EMBEDDING_URL);
(enabled ? describe : describe.skip)("frozen recall evaluation CLI with real embedding and ES", () => {
  it("builds both chunk layouts and a frozen v1 baseline, then replays six variants without modifying live aliases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recall-evaluation-test-"));
    const base = `test_evaluation_${randomUUID().replaceAll("-", "")}`;
    const indices = [`${base}_recall_v2_eval_visual`, `${base}_recall_v2_eval_legacy`, `${base}_recall_eval_v1_baseline`];
    const client = new ElasticsearchClient({ url: process.env.TEST_RECALL_ES_URL!, username: process.env.TEST_RECALL_ES_USERNAME,
      password: process.env.TEST_RECALL_ES_PASSWORD, timeoutMs: 30000 });
    const env = { ...process.env, APP_MODE: "dev", DATABASE_URL: "mysql://root@localhost/recall_integration_test", DEV_DATABASE_NAME: "recall_integration_test",
      DEV_ELASTICSEARCH_INDEX: base, ELASTICSEARCH_URL: process.env.TEST_RECALL_ES_URL!,
      ELASTICSEARCH_USERNAME: process.env.TEST_RECALL_ES_USERNAME ?? "", ELASTICSEARCH_PASSWORD: process.env.TEST_RECALL_ES_PASSWORD ?? "",
      EMBEDDING_BASE_URL: process.env.TEST_RECALL_EMBEDDING_URL!, EMBEDDING_API_KEY: process.env.TEST_RECALL_EMBEDDING_API_KEY ?? "",
      EMBEDDING_MODEL: deployment.identity.model, EMBEDDING_REVISION: deployment.revision, SEARCH_RECALL_ENGINE: "v1", SEARCH_V2_EMBED_CONCURRENCY: "1" };
    const execute = (script: string, args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", script, ...args], { env, timeout: 45000, maxBuffer: 100000 });
    try {
      const assetId = randomUUID();
      const sources = [{ assetId, kind: "public", sourceGroup: assetId, processingStatus: "completed", reviewStatus: "published",
        source: { id: assetId, name: "回归样本", description: "海边日出", analysis: null, tags: [], segmentStartMs: null, segmentEndMs: null } }];
      const snapshotHash = fingerprint(sources);
      const inputPath = join(directory, "input.json");
      await writeFile(inputPath, JSON.stringify({ schemaVersion: 1, stage: "unjudged-input", sources, sourceSnapshotHash: snapshotHash }));
      const visualPath = join(directory, "visual.json"), legacyPath = join(directory, "legacy.json");
      for (const [chunker, buildId, manifestPath] of [["visual-v2", "eval_visual", visualPath], ["legacy-v1", "eval_legacy", legacyPath]]) {
        await execute("scripts/prepare-recall-build.ts", ["--base-index", base, "--build-id", buildId, "--chunker", chunker, "--source-snapshot", inputPath, "--output", manifestPath]);
        const output = join(directory, `${chunker}-build.json`);
        await execute("scripts/build-recall-evaluation-index.ts", ["--input", inputPath, "--manifest", manifestPath, "--base-index", base, "--output", output,
          ...(chunker === "legacy-v1" ? ["--reuse-manifest", visualPath] : []), "--apply"]);
        expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ complete: true, fullSnapshot: true, assets: 1, chunks: 1 });
        if (chunker === "legacy-v1") expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ reusedExactInputs: 1, networkEmbeddedTexts: 0 });
      }
      const baselineReport = join(directory, "baseline-build.json");
      await execute("scripts/build-recall-v1-baseline.ts", ["--input", inputPath, "--legacy-manifest", legacyPath, "--base-index", base, "--index", indices[2], "--output", baselineReport, "--apply"]);
      expect(JSON.parse(await readFile(baselineReport, "utf8"))).toMatchObject({ complete: true, chunks: 1, writtenChunks: 1 });
      const dataset: EvaluationDataset = { schemaVersion: 1, frozenAt: new Date().toISOString(), provenance: "synthetic", sourceSnapshotHash: snapshotHash,
        assets: [{ assetId, sourceGroup: assetId, partition: "test" }], queries: [
          { id: "one", text: "海边日出", entry: "assets-query", group: "sea", partition: "test", eligibleAssetIds: [assetId], noMatch: null, poolComplete: false, judgments: [] },
          { id: "empty", text: "海边日出", entry: "segment-match", group: "sea", partition: "test", eligibleAssetIds: [], noMatch: null, poolComplete: false, judgments: [] },
        ] };
      const datasetPath = join(directory, "dataset.json");
      await writeFile(datasetPath, JSON.stringify(freezeDataset(dataset).data));
      for (const system of ["v1", "v2-hybrid", "v2-semantic", "v2-lexical", "v2-no-metadata", "v2-old-chunks"]) {
        const output = join(directory, `${system}-run.json`);
        await execute("scripts/shadow-recall.ts", ["--dataset", datasetPath, "--manifest", system === "v2-old-chunks" ? legacyPath : visualPath,
          "--policy", "config/recall/experimental-policy.json", "--system", system, "--base-index", base, "--v1-index", indices[2],
          "--hardware", "integration-fixture", "--interval-ms", "0", "--output", output]);
        const run: EvaluationRun = JSON.parse(await readFile(output, "utf8"));
        expect(run.results).toHaveLength(2);
        expect(run.results.every((result) => !result.error)).toBe(true);
        expect(run.results[1].assetIds).toEqual([]);
        expect(run.results[0].assetIds.every((id) => id === assetId)).toBe(true);
        if (system === "v2-hybrid" || system === "v2-semantic") expect(run.results[0].assetIds).toEqual([assetId]);
      }
      await client.request(`/${indices[0]}/_settings`, { method: "PUT", body: JSON.stringify({ "index.blocks.write": false }) });
      await expect(execute("scripts/shadow-recall.ts", ["--dataset", datasetPath, "--manifest", visualPath,
        "--policy", "config/recall/experimental-policy.json", "--system", "v2-hybrid", "--base-index", base,
        "--hardware", "integration-fixture", "--output", join(directory, "must-not-pass.json")])).rejects.toThrow();
    } finally {
      for (const index of indices) await client.request(`/${index}`, { method: "DELETE" }, [404]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
