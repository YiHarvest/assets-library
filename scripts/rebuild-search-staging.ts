import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { loadConfig } from "../src/server/config";
import { db, pool } from "../src/server/db";
import { assetEntries } from "../src/server/db/schema";
import { getAssetDetail } from "../src/server/repositories/assets";
import { assetEvidence } from "../src/server/search/asset-evidence";
import { assetSearchMetadata, deleteAssetIndex, indexAsset } from "../src/server/search/elasticsearch";

interface State {
  version: 1; buildId: string; index: string; indexUuid?: string; activeIndex: string;
  database: string; model: string; analyzer: string; sourceHash: string;
  startedAt: string; updatedAt: string; status: "building" | "snapshot_complete" | "incomplete";
  assets: Record<string, { hash: string; documents: number }>;
  failures: Record<string, string>; eligible: number;
  verification?: { documents: number; assets: number; evidence: unknown; activeIndexUntouched: boolean };
}

export async function rebuildSearchStaging(stateFile = process.argv[2]) {
  const config = loadConfig();
  assert.ok(config.ELASTICSEARCH_URL && config.embeddingConfigured, "ES and embedding must be configured");
  const sources = ["src/server/search/asset-evidence.ts", "src/server/search/elasticsearch.ts", "src/server/repositories/assets.ts", "src/shared/contracts.ts"];
  const sourceHash = createHash("sha256").update((await Promise.all(sources.map(file => readFile(file)))).map(bytes => createHash("sha256").update(bytes).digest("hex")).join(":" )).digest("hex");
  const buildId = randomUUID();
  const statePath = resolve(stateFile ?? `.run/search-rebuild/${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
  const saved = await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  const state: State = saved ? JSON.parse(saved) : {
    version: 1, buildId, index: `${config.ELASTICSEARCH_INDEX}_staging_${buildId.replaceAll("-", "")}`,
    activeIndex: config.ELASTICSEARCH_INDEX, database: config.databaseTarget.database, model: config.EMBEDDING_MODEL!,
    analyzer: config.ELASTICSEARCH_ANALYZER, sourceHash, startedAt: new Date().toISOString(), updatedAt: "",
    status: "building", assets: {}, failures: {}, eligible: 0,
  };
  assert.equal(state.version, 1);
  assert.equal(state.activeIndex, config.ELASTICSEARCH_INDEX, "Active index changed; review before resuming");
  assert.equal(state.database, config.databaseTarget.database);
  assert.equal(state.model, config.EMBEDDING_MODEL);
  assert.equal(state.analyzer, config.ELASTICSEARCH_ANALYZER);
  assert.equal(state.sourceHash, sourceHash, "Indexing source changed; start a separate build");
  assert.equal(state.index, `${state.activeIndex}_staging_${state.buildId.replaceAll("-", "")}`);
  assert.ok(![config.DEV_ELASTICSEARCH_INDEX, config.PRD_ELASTICSEARCH_INDEX].includes(state.index));
  const request = async (path: string, method = "GET", body?: object) => {
    const response = await fetch(`${config.ELASTICSEARCH_URL!.replace(/\/$/, "")}${path}`, {
      method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", ...(config.ELASTICSEARCH_USERNAME ? {
        authorization: `Basic ${Buffer.from(`${config.ELASTICSEARCH_USERNAME}:${config.ELASTICSEARCH_PASSWORD ?? ""}`).toString("base64")}`,
      } : {}) },
    });
    if (response.status === 404) return null;
    assert.ok(response.ok, `ES ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const indexPath = `/${encodeURIComponent(state.index)}`;
  const verifyIsolation = async () => {
    for (const name of new Set([config.DEV_ELASTICSEARCH_INDEX, config.PRD_ELASTICSEARCH_INDEX])) {
      const resolved = await request(`/_resolve/index/${encodeURIComponent(name)}`);
      const physical = [...(resolved?.indices ?? []).map((item: { name: string }) => item.name),
        ...(resolved?.aliases ?? []).flatMap((item: { indices: string[] }) => item.indices)];
      assert.ok(!physical.includes(state.index), "Staging index is serving live traffic; stopped");
    }
    const info = await request(indexPath);
    if (info) {
      assert.ok(saved || state.indexUuid, "Generated index already exists");
      assert.equal(info[state.index].settings.index.uuid, state.indexUuid, "Staging index identity changed");
      assert.equal(info[state.index].mappings._meta?.stagingBuildId, state.buildId, "Staging ownership mismatch");
      assert.equal(Object.keys(info[state.index].aliases).length, 0, "Staging index acquired an alias; stopped");
    } else assert.ok(!state.indexUuid, "Staging index disappeared; start a separate build");
  };
  await verifyIsolation();
  const activeBefore = await request(`/${encodeURIComponent(config.ELASTICSEARCH_INDEX)}/_mapping`);
  const save = async () => {
    state.updatedAt = new Date().toISOString();
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  };
  const key = config.APP_MODE === "prd" ? "PRD_ELASTICSEARCH_INDEX" : "DEV_ELASTICSEARCH_INDEX";
  const previous = process.env[key];
  process.env[key] = state.index; // Only this process; no .env, aliases, jobs or index-state writes.
  assert.equal(loadConfig().ELASTICSEARCH_INDEX, state.index);
  state.status = "building";
  await save();
  console.log(JSON.stringify({ event: "staging_rebuild_started", statePath, index: state.index, activeIndex: state.activeIndex, resumed: !!saved }));
  try {
    // Two bounded passes catch changes during the initial scan. Resume performs another reconciliation.
    for (let pass = 1; pass <= 2; pass++) {
      const rows = await db.select({ id: assetEntries.id }).from(assetEntries).where(and(
        isNull(assetEntries.deletedAt), ne(assetEntries.reviewStatus, "deleted"), eq(assetEntries.processingStatus, "completed"),
      )).orderBy(asc(assetEntries.id));
      assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate public/private IDs");
      state.eligible = rows.length;
      const current = new Set(rows.map(row => row.id));
      for (const id of Object.keys(state.failures)) if (!current.has(id)) delete state.failures[id];
      for (const id of Object.keys(state.assets)) if (!current.has(id)) {
        await deleteAssetIndex(id); delete state.assets[id]; delete state.failures[id];
      }
      console.log(JSON.stringify({ event: "staging_pass", pass, eligible: rows.length }));
      for (const [offset, { id }] of rows.entries()) {
        if (offset % 25 === 0) await verifyIsolation();
        try {
          const asset = await getAssetDetail(id, { includeAllUsers: true });
          const evidence = assetEvidence(asset);
          const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
          if (state.assets[id]?.hash !== hash) {
            await indexAsset(asset);
            if (!state.indexUuid) {
              await request(`${indexPath}/_mapping`, "PUT", { _meta: { stagingBuildId: state.buildId, sourceHash, model: state.model } });
              state.indexUuid = (await request(indexPath))[state.index].settings.index.uuid;
            }
            state.assets[id] = { hash, documents: evidence.chunks.length ? evidence.chunks.length + (assetSearchMetadata(asset) ? 1 : 0) : 0 };
            await pause(100); // One embedding request at a time, with a pause between assets.
          }
          delete state.failures[id];
        } catch (error) {
          state.failures[id] = error instanceof Error ? error.message : "Indexing failed";
          console.error(JSON.stringify({ event: "staging_asset_failed", assetId: id, message: state.failures[id] }));
        }
        await save();
        if ((offset + 1) % 25 === 0 || offset + 1 === rows.length) console.log(JSON.stringify({
          event: "staging_progress", pass, scanned: offset + 1, eligible: rows.length, indexed: Object.keys(state.assets).length, failures: Object.keys(state.failures).length,
        }));
      }
    }
    await verifyIsolation();
    const stats = await request(`${indexPath}/_search`, "POST", { size: 0, track_total_hits: true, aggs: {
      assets: { cardinality: { field: "assetId", precision_threshold: 40000 } }, evidence: { terms: { field: "evidenceKind", size: 10 } },
    } });
    const expectedDocuments = Object.values(state.assets).reduce((sum, asset) => sum + asset.documents, 0);
    assert.equal(stats?.hits.total.value ?? 0, expectedDocuments, "Document count mismatch");
    const activeAfter = await request(`/${encodeURIComponent(config.ELASTICSEARCH_INDEX)}/_mapping`);
    state.verification = { documents: expectedDocuments, assets: stats?.aggregations.assets.value ?? 0,
      evidence: stats?.aggregations.evidence.buckets ?? [], activeIndexUntouched: JSON.stringify(activeBefore) === JSON.stringify(activeAfter) };
    assert.ok(state.verification.activeIndexUntouched, "Live mapping changed during build; investigate before switching");
    state.status = Object.keys(state.failures).length ? "incomplete" : "snapshot_complete";
    await save();
    console.log(JSON.stringify({ event: "staging_rebuild_finished", status: state.status, index: state.index, verification: state.verification,
      notice: "Not activated. Production writes still go to the old index; resume to reconcile again before any later switch." }));
    if (state.status === "incomplete") process.exitCode = 1;
  } catch (error) {
    state.status = "incomplete"; await save(); throw error;
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
}

if (process.argv[1]?.endsWith("rebuild-search-staging.ts")) {
  rebuildSearchStaging().catch(error => { console.error(error instanceof Error ? error.message : "Staging rebuild failed"); process.exitCode = 1; }).finally(() => pool.end());
}
