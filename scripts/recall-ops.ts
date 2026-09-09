import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../src/server/config";
import { openDatabase } from "../src/server/db/connection";
import { recallBuilds } from "../src/server/db/schema";
import { parseSearchManifest } from "../src/server/search/v2/manifest";
import { parseRecallPolicy } from "../src/server/search/v2/policy";
import { fingerprint } from "../src/server/search/v2/fingerprint";
import { ElasticsearchClient, createSearchIndex } from "../src/server/search/v2/elasticsearch";
import { loadSearchBuildRuntime } from "../src/server/search/v2/runtime";
import { registerRecallBuild } from "../src/server/search/v2/repository";
import { backfillRecallBatch, restartRecallBackfill } from "../src/server/search/v2/backfill";
import { checkRecallReadiness } from "../src/server/search/v2/readiness";
import { readRecallAlias, switchRecallAlias } from "../src/server/search/v2/switch";
import { checkLegacyRollback } from "../src/server/search/v2/rollback";
import { evaluateRecall, runSchema } from "../benchmarks/search/evaluation";

async function main() {
  const { values } = parseArgs({ options: {
    operation: { type: "string" }, manifest: { type: "string" }, "base-index": { type: "string" }, output: { type: "string" },
    apply: { type: "boolean", default: false }, "batch-size": { type: "string", default: "100" },
    "max-batches": { type: "string", default: "1" }, "expected-index": { type: "string" },
    dataset: { type: "string" }, baseline: { type: "string" }, candidate: { type: "string" }, policy: { type: "string" },
    "ablation-runs": { type: "string", multiple: true },
  } });
  const operation = values.operation;
  if (!operation || !["provision", "backfill", "rescan", "check", "rollback-check", "switch"].includes(operation) || !values.manifest || !values["base-index"] || !values.output) {
    throw new Error("Usage: recall-ops --operation provision|backfill|rescan|check|rollback-check|switch --manifest FILE --base-index NAME --output NEW_FILE [--apply] [--batch-size 100 --max-batches 1]");
  }
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const manifest = parseSearchManifest(await read(values.manifest));
  const config = loadConfig();
  const base = values["base-index"];
  if (base !== config.ELASTICSEARCH_INDEX || !manifest.physicalIndex.startsWith(`${base}_recall_v2_`)) throw new Error("Explicit build target differs from configured environment");
  if (!config.ELASTICSEARCH_URL) throw new Error("ES configuration is required");
  const batchSize = Number(values["batch-size"]), maxBatches = Number(values["max-batches"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error("Invalid backfill request budget");
  const client = new ElasticsearchClient({ url: config.ELASTICSEARCH_URL, username: config.ELASTICSEARCH_USERNAME,
    password: config.ELASTICSEARCH_PASSWORD, timeoutMs: config.SEARCH_TIMEOUT_MS });
  // Never imports the auto-migrating application singleton. Migration 0009 is a
  // separate deploy step, reviewed and applied using the project's existing flow.
  const output = await open(values.output, "wx", 0o600);
  const database = openDatabase({ url: config.databaseUrl, sslCaPath: config.DATABASE_SSL_CA_PATH, poolSize: 2 });
  let lock: PoolConnection | undefined;
  const lockName = `recall-ops:${fingerprint({ database: new URL(config.databaseUrl).pathname, base }).slice(0, 48)}`;
  let acquired = false;
  try {
    lock = await database.pool.getConnection();
    const [rows] = await lock.query<Array<RowDataPacket & { acquired: number }>>("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
    if (rows[0].acquired !== 1) throw new Error("Another recall operation owns the environment deployment lock");
    acquired = true;
    if (operation !== "provision") {
      const [stored] = await database.db.select().from(recallBuilds).where(eq(recallBuilds.buildId, manifest.buildId));
      if (!stored || stored.manifestHash !== fingerprint(manifest) || stored.physicalIndex !== manifest.physicalIndex) throw new Error("Provided manifest differs from the registered build");
    }
    let report: unknown;
    if (operation === "provision") {
      report = { operation, applied: values.apply, buildId: manifest.buildId, physicalIndex: manifest.physicalIndex,
        manifestHash: fingerprint(manifest), actions: ["create or verify dedicated ES index", "register immutable build with writeEnabled=true"],
        prerequisites: ["migration 0009 applied", "verified model identity and tokenizer deployed", "enable persistent dual writes on every writer before backfill"] };
      if (values.apply) {
        await createSearchIndex(client, manifest);
        await loadSearchBuildRuntime(manifest);
        await registerRecallBuild(database.db, manifest);
      }
    } else if (operation === "backfill" || operation === "rescan") {
      if (!config.SEARCH_V2_WRITE_ENABLED) throw new Error("Persistent dual writes must be enabled before backfill");
      await loadSearchBuildRuntime(manifest);
      if (!values.apply) report = { operation, applied: false, buildId: manifest.buildId, batchSize, maxBatches,
        actions: operation === "rescan" ? ["reset only this build's keyset cursor; keep revisions and jobs"] : ["read current source views", "enqueue pinned jobs and commit keyset progress"] };
      else if (operation === "rescan") {
        await restartRecallBackfill(database.db, manifest.buildId);
        report = { operation, applied: true, buildId: manifest.buildId };
      } else {
        const batches = [];
        for (let i = 0; i < maxBatches; i++) {
          const batch = await backfillRecallBatch(database.db, manifest.buildId, batchSize);
          batches.push(batch);
          console.log(JSON.stringify({ batches: batches.length, processed: batch.processed, completed: batch.completed }));
          if (batch.completed) break;
        }
        report = { operation, applied: true, buildId: manifest.buildId, batches };
      }
    } else if (operation === "check") {
      report = await checkRecallReadiness(database.db, client, manifest.buildId);
    } else if (operation === "rollback-check") {
      report = await checkLegacyRollback(database.db, client, manifest.buildId, base);
    } else {
      if (!values.dataset || !values.baseline || !values.candidate || !values.policy || values["expected-index"] === undefined) {
        throw new Error("Switch requires dataset, baseline, candidate, policy, ablation-runs and expected-index (use none for an absent alias)");
      }
      const baseline = runSchema.parse(await read(values.baseline)), candidate = runSchema.parse(await read(values.candidate));
      const evaluation = evaluateRecall(await read(values.dataset), baseline, candidate);
      const policy = parseRecallPolicy(await read(values.policy));
      if (!policy.validated || evaluation.candidateManifestHash !== fingerprint(manifest) || evaluation.candidatePolicyHash !== fingerprint(policy)) throw new Error("Evaluated policy/build does not match the proposed switch");
      const ablations = await Promise.all((values["ablation-runs"] ?? []).map(async (path) => runSchema.parse(await read(path))));
      const required = ["v2-semantic", "v2-lexical", "v2-no-metadata", "v2-old-chunks"];
      for (const system of required) {
        const run = ablations.find((item) => item.system === system);
        if (!run || run.datasetHash !== evaluation.datasetHash || fingerprint(run.measurement) !== fingerprint(candidate.measurement) ||
          run.results.some((result) => result.error) || candidate.results.some((result) => !run.results.some((other) => other.queryId === result.queryId))) throw new Error("Missing, incomplete or unmatched ablation evidence");
      }
      const readiness = await checkRecallReadiness(database.db, client, manifest.buildId);
      const expected = values["expected-index"] === "none" ? null : values["expected-index"];
      const current = await readRecallAlias(client.request.bind(client), base);
      report = { operation, applied: false, expected, current, target: manifest.physicalIndex, readiness, evaluation,
        environmentChanges: { SEARCH_RECALL_ENGINE: "v2", SEARCH_V2_POLICY_PATH: values.policy, SEARCH_V2_WRITE_ENABLED: "true" } };
      if (values.apply) {
        if (!config.SEARCH_V2_WRITE_ENABLED || !readiness.ready || !evaluation.eligibleForCutover) throw new Error("Switch gates have not passed");
        const switched = await switchRecallAlias(client.request.bind(client), base, expected, manifest.physicalIndex);
        report = { ...report as object, applied: true, switched,
          next: "Deploy the recorded environment changes to every reader; keep v1 and all rollback builds writing. This command does not restart services." };
      }
    }
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ operation, applied: values.apply && !["check", "rollback-check"].includes(operation), report: values.output }));
  } catch (error) {
    await output.writeFile(`${JSON.stringify({ operation, completed: false, buildId: manifest.buildId,
      message: "Operation did not complete. Inspect database build state and current alias before retrying; no automatic rollback was attempted." }, null, 2)}\n`);
    throw error;
  } finally {
    await output.close();
    try { if (acquired && lock) await lock.query("SELECT RELEASE_LOCK(?)", [lockName]); }
    finally { lock?.release(); await database.pool.end(); }
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Recall operation failed. No automatic fallback or index deletion is performed; inspect the current build and alias before retrying.");
  process.exitCode = 1;
});
