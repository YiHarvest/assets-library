import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import { loadConfig } from "../src/server/config";
import { assetSearchChunks } from "../src/server/search/elasticsearch";
import type { SearchAssetSource } from "../src/server/search/v2/types";
import { fingerprint, hashText } from "../src/server/search/v2/fingerprint";
import { parseSearchManifest } from "../src/server/search/v2/manifest";
import { ElasticsearchClient, readSearchManifest } from "../src/server/search/v2/elasticsearch";
import { validVector } from "../src/server/search/v2/writer";
import { baselineImplementationHash } from "../benchmarks/search/baseline-identity";

/** Rebuild the unchanged v1 chunk layout from the exact frozen sources. Vectors
 * come only from a verified legacy-v1 ablation build with the same text/model. */
async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" }, "legacy-manifest": { type: "string" },
    "base-index": { type: "string" }, index: { type: "string" }, output: { type: "string" }, apply: { type: "boolean", default: false } } });
  if (!values.input || !values["legacy-manifest"] || !values["base-index"] || !values.index || !values.output) throw new Error("Usage: build-recall-v1-baseline --input FILE --legacy-manifest FILE --base-index NAME --index DEDICATED_INDEX --output NEW_FILE [--apply]");
  const config = loadConfig();
  const input = JSON.parse(await readFile(values.input, "utf8"));
  const manifest = parseSearchManifest(JSON.parse(await readFile(values["legacy-manifest"], "utf8")));
  if (!Array.isArray(input.sources) || fingerprint(input.sources) !== input.sourceSnapshotHash || manifest.evaluationSourceSnapshotHash !== input.sourceSnapshotHash ||
    manifest.chunker.version !== "legacy-v1" || manifest.embedding.preprocessing !== "trim-v1") throw new Error("Baseline requires the exact legacy chunk/source identity");
  if (config.ELASTICSEARCH_INDEX !== values["base-index"] || !values.index.startsWith(`${values["base-index"]}_recall_eval_v1_`) ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(values.index) || !manifest.physicalIndex.startsWith(`${values["base-index"]}_recall_v2_eval_`)) throw new Error("Baseline target differs from explicit evaluation environment");
  const sources: SearchAssetSource[] = input.sources.map((row: { source: SearchAssetSource }) => row.source);
  const identity = { schemaVersion: 1, sourceSnapshotHash: input.sourceSnapshotHash, embedding: manifest.embedding,
    analyzer: config.ELASTICSEARCH_ANALYZER, legacyChunkLayout: "description-visualSegments-keyMoments-timeline-trim-dedup-v1",
    baselineReferenceRevision: "3706b8b2f135d7a92cba3628419f7a42aeb6fccd", implementationHash: await baselineImplementationHash() };
  const report = { identity, identityHash: fingerprint(identity), index: values.index, applied: values.apply,
    complete: false, assets: sources.length, chunks: sources.reduce((sum, source) => sum + assetSearchChunks(source).length, 0), writtenChunks: 0,
    elapsedMs: 0, primaryStoreBytes: null as number | null };
  const output = await open(values.output, "wx", 0o600);
  try {
    if (values.apply) {
      if (!config.ELASTICSEARCH_URL) throw new Error("ES is not configured");
      const client = new ElasticsearchClient({ url: config.ELASTICSEARCH_URL, username: config.ELASTICSEARCH_USERNAME,
        password: config.ELASTICSEARCH_PASSWORD, timeoutMs: config.SEARCH_TIMEOUT_MS });
      if (fingerprint(await readSearchManifest(client, manifest.physicalIndex)) !== fingerprint(manifest)) throw new Error("Legacy build manifest differs");
      if ((await client.request(`/${values.index}`, { method: "HEAD" }, [404])).status !== 404) throw new Error("Baseline index already exists");
      await client.request(`/${values.index}`, { method: "PUT", body: JSON.stringify({ mappings: { _meta: { recallBaseline: identity, identityHash: fingerprint(identity) }, properties: {
        assetId: { type: "keyword" }, content: { type: "text", analyzer: config.ELASTICSEARCH_ANALYZER, search_analyzer: config.ELASTICSEARCH_ANALYZER },
        embedding: { type: "dense_vector", dims: manifest.embedding.dimensions, index: true, similarity: "cosine" },
      } } }) });
      const started = performance.now();
      for (let offset = 0; offset < sources.length; offset += 10) {
        const batch = sources.slice(offset, offset + 10);
        const stored = await (await client.request(`/${manifest.physicalIndex}/_mget`, { method: "POST", body: JSON.stringify({ ids: batch.map((source) => source.id) }) })).json();
        if (!Array.isArray(stored.docs) || stored.docs.some((document: { error?: unknown; found?: boolean }) => document.error || !document.found)) throw new Error("Legacy build is incomplete");
        type LegacyDocument = { deleted: boolean; embeddingFingerprint: string;
          chunks: Array<{ text: string; textHash: string; embedding: number[] }> };
        const storedDocuments: Array<{ _id: string; _source: LegacyDocument }> = stored.docs;
        const byId = new Map(storedDocuments.map((document) => [document._id, document._source] as const));
        const operations: unknown[] = [];
        for (const source of batch) {
          const document = byId.get(source.id);
          if (!document || document.deleted || document.embeddingFingerprint !== fingerprint(manifest.embedding)) throw new Error("Legacy embedding identity differs");
          const chunks = assetSearchChunks(source);
          for (const [index, content] of chunks.entries()) {
            const chunk = document.chunks.find((item) => item.text === content && item.textHash === hashText(content));
            if (!chunk || !validVector(chunk.embedding, manifest.embedding.dimensions)) throw new Error("Legacy text/vector identity is missing");
            operations.push({ index: { _id: `${source.id}:${index}` } }, { assetId: source.id, content, embedding: chunk.embedding });
          }
        }
        if (operations.length) {
          const result = await (await client.request(`/${values.index}/_bulk?refresh=false`, { method: "POST", headers: { "content-type": "application/x-ndjson" },
            body: `${operations.map((operation) => JSON.stringify(operation)).join("\n")}\n` })).json();
          if (result.errors) throw new Error("Baseline bulk write failed");
          report.writtenChunks += operations.length / 2;
        }
        if ((offset + batch.length) % 100 === 0) console.log(JSON.stringify({ assets: offset + batch.length, chunks: report.writtenChunks }));
      }
      const refreshed = await (await client.request(`/${values.index}/_refresh`, { method: "POST" })).json();
      if (refreshed._shards?.failed) throw new Error("Baseline refresh failed");
      const count = await (await client.request(`/${values.index}/_count`)).json();
      if (count._shards?.failed || count.count !== report.chunks) throw new Error("Baseline chunk count differs");
      const stats = await (await client.request(`/${values.index}/_stats/store`)).json();
      report.primaryStoreBytes = stats.indices?.[values.index]?.primaries?.store?.size_in_bytes ?? null;
      await client.request(`/${values.index}/_mapping`, { method: "PUT", body: JSON.stringify({ _meta: {
        recallBaseline: identity, identityHash: fingerprint(identity), recallEvaluation: {
          sourceSnapshotHash: input.sourceSnapshotHash, assets: sources.length, chunks: report.chunks, complete: true, fullSnapshot: true },
      } }) });
      await client.request(`/${values.index}/_settings`, { method: "PUT", body: JSON.stringify({ "index.blocks.write": true }) });
      report.elapsedMs = performance.now() - started;
      report.complete = true;
    }
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } catch (error) {
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally { await output.close(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Frozen v1 baseline build failed; inspect its protected report. Live indices and aliases were not modified.");
  process.exitCode = 1;
});
