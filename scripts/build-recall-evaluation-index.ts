import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { loadConfig } from "../src/server/config";
import { analysisResultSchema } from "../src/shared/contracts";
import { fingerprint } from "../src/server/search/v2/fingerprint";
import { parseSearchManifest } from "../src/server/search/v2/manifest";
import { ElasticsearchClient, createSearchIndex, readSearchManifest, searchDocumentStore } from "../src/server/search/v2/elasticsearch";
import { loadSearchBuildRuntime } from "../src/server/search/v2/runtime";
import { buildSearchDocument } from "../src/server/search/v2/document";
import { validVector, writeSearchDocument } from "../src/server/search/v2/writer";
import { loadSearchTokenizer } from "../src/server/search/v2/tokenizer";

const sourceSchema = z.object({ id: z.string().uuid(), name: z.string(), description: z.string(), analysis: analysisResultSchema.nullable(),
  tags: z.array(z.object({ category: z.string(), value: z.string(), source: z.enum(["human", "model"]).optional() })),
  segmentStartMs: z.number().nullable(), segmentEndMs: z.number().nullable() });

/** Offline capacity experiment. Default is a dry build. Only a fresh explicit
 * *_recall_v2_eval_* index can be created; no DB, business index or alias writes. */
async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" }, manifest: { type: "string" }, output: { type: "string" },
    "base-index": { type: "string" }, "reuse-manifest": { type: "string" }, apply: { type: "boolean", default: false }, "max-assets": { type: "string", default: "50" } } });
  if (!values.input || !values.manifest || !values.output || !values["base-index"]) throw new Error("Usage: build-recall-evaluation-index --input FILE --manifest FILE --base-index NAME --output NEW_FILE [--max-assets 50] [--apply]");
  const maximum = Number(values["max-assets"]);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 65536) throw new Error("Invalid asset budget");
  const input = JSON.parse(await readFile(values.input, "utf8"));
  if (input.stage !== "unjudged-input" || !Array.isArray(input.sources) || fingerprint(input.sources) !== input.sourceSnapshotHash) throw new Error("Input is not the recorded source snapshot");
  const manifest = parseSearchManifest(JSON.parse(await readFile(values.manifest, "utf8")));
  const reuseManifest = values["reuse-manifest"] ? parseSearchManifest(JSON.parse(await readFile(values["reuse-manifest"], "utf8"))) : undefined;
  if (manifest.evaluationSourceSnapshotHash !== input.sourceSnapshotHash) throw new Error("Evaluation manifest is not bound to this source snapshot");
  if (reuseManifest && (reuseManifest.evaluationSourceSnapshotHash !== input.sourceSnapshotHash || reuseManifest.physicalIndex === manifest.physicalIndex ||
    fingerprint({ ...reuseManifest.embedding, preprocessing: undefined }) !== fingerprint({ ...manifest.embedding, preprocessing: undefined }))) throw new Error("Reuse requires the same frozen source and serving model identity");
  const config = loadConfig();
  if (config.ELASTICSEARCH_INDEX !== values["base-index"] || !manifest.physicalIndex.startsWith(`${values["base-index"]}_recall_v2_eval_`)) throw new Error("Experiment target must be a dedicated eval index in the explicit environment");
  const sources = input.sources.slice(0, maximum).map((row: { source: unknown }) => sourceSchema.parse(row.source));
  if (new Set(sources.map((source: z.infer<typeof sourceSchema>) => source.id)).size !== sources.length) throw new Error("Duplicate source identity");
  const tokenizer = await loadSearchTokenizer(config.SEARCH_V2_TOKENIZER_DIR, manifest.embedding);
  const started = performance.now();
  const documents = sources.map((source: z.infer<typeof sourceSchema>) => buildSearchDocument(source, 1, manifest, tokenizer));
  const output = await open(values.output, "wx", 0o600);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceSnapshotHash: input.sourceSnapshotHash,
    manifestHash: fingerprint(manifest), physicalIndex: manifest.physicalIndex, chunker: manifest.chunker.version,
    applied: values.apply, complete: false, fullSnapshot: sources.length === input.sources.length,
    assets: documents.length, chunks: documents.reduce((sum: number, document: ReturnType<typeof buildSearchDocument>) => sum + document.chunks.length, 0),
    maximumChunks: documents.reduce((maximum: number, document: ReturnType<typeof buildSearchDocument>) => Math.max(maximum, document.chunks.length), 0),
    maximumTokens: documents.reduce((maximum: number, document: ReturnType<typeof buildSearchDocument>) =>
      document.chunks.reduce((value, chunk) => Math.max(value, chunk.tokenCount), maximum), 0),
    localBuildMs: performance.now() - started, writes: [] as Array<{ assetId: string; contentHash: string; chunks: number; elapsedMs: number }>,
    totalWriteMs: 0, refreshMs: 0, primaryStoreBytes: null as number | null, networkEmbeddedTexts: 0, reusedExactInputs: 0,
    reusedFromManifestHash: reuseManifest ? fingerprint(reuseManifest) : null,
    note: "Single sequential writer with deferred refresh followed by one explicit refresh. Measures bulk-build cost, not live write visibility latency or recall quality." };
  try {
    if (values.apply) {
      if (!config.ELASTICSEARCH_URL) throw new Error("ES is not configured");
      class ExperimentClient extends ElasticsearchClient {
        override request(path: string, init?: RequestInit, allowedStatuses?: number[]) {
          // Refresh is deferred only in this isolated experiment; production store
          // continues using refresh=wait_for. Individual asset replacement is atomic.
          return super.request(path.replace("refresh=wait_for", "refresh=false"), init, allowedStatuses);
        }
      }
      const client = new ExperimentClient({ url: config.ELASTICSEARCH_URL, username: config.ELASTICSEARCH_USERNAME,
        password: config.ELASTICSEARCH_PASSWORD, timeoutMs: config.SEARCH_TIMEOUT_MS });
      if ((await client.request(`/${manifest.physicalIndex}`, { method: "HEAD" }, [404])).status !== 404) throw new Error("Evaluation index already exists; choose a fresh build ID");
      if (reuseManifest && fingerprint(await readSearchManifest(client, reuseManifest.physicalIndex)) !== fingerprint(reuseManifest)) throw new Error("Reuse source index manifest differs");
      await createSearchIndex(client, manifest);
      const runtime = await loadSearchBuildRuntime(manifest);
      const store = searchDocumentStore(client, manifest);
      const writeStart = performance.now();
      for (const document of documents) {
        const tick = performance.now();
        const cache = new Map<string, number[]>();
        if (reuseManifest) {
          const previous = await searchDocumentStore(client, reuseManifest).read(document.assetId);
          if (!previous || previous.version !== 1 || previous.document.assetId !== document.assetId || previous.document.deleted ||
            previous.document.embeddingFingerprint !== fingerprint(reuseManifest.embedding)) throw new Error("Reuse source document is missing or has changed");
          for (const chunk of previous.document.chunks) if (validVector(chunk.embedding, manifest.embedding.dimensions)) cache.set(chunk.text, chunk.embedding);
        }
        const result = await writeSearchDocument(document, manifest, store, async (texts) => {
          // Offline memoization across two controlled layouts. Only raw input text
          // equality plus identical model, tokenizer, serving revision and vector
          // normalization permits reuse. Production fingerprint rules are unchanged.
          const missing = texts.filter((item) => !cache.has(item.text));
          const vectors = missing.length ? await runtime.embed(missing) : [];
          report.networkEmbeddedTexts += missing.length;
          report.reusedExactInputs += texts.length - missing.length;
          for (const [index, item] of missing.entries()) cache.set(item.text, vectors[index]);
          return texts.map((item) => cache.get(item.text)!);
        });
        if (result.status === "superseded") throw new Error("An external writer changed the frozen evaluation index");
        report.writes.push({ assetId: document.assetId, contentHash: document.contentHash, chunks: document.chunks.length, elapsedMs: performance.now() - tick });
        if (report.writes.length % 100 === 0) console.log(JSON.stringify({ indexed: report.writes.length, total: documents.length, physicalIndex: manifest.physicalIndex }));
      }
      report.totalWriteMs = performance.now() - writeStart;
      const refreshStart = performance.now();
      const refreshed = await (await client.request(`/${manifest.physicalIndex}/_refresh`, { method: "POST" })).json();
      if (refreshed._shards?.failed) throw new Error("Experiment refresh failed");
      report.refreshMs = performance.now() - refreshStart;
      const count = await (await client.request(`/${manifest.physicalIndex}/_count`)).json();
      if (count._shards?.failed || count.count !== documents.length) throw new Error("Experiment root count differs from sources");
      const stats = await (await client.request(`/${manifest.physicalIndex}/_stats/store`)).json();
      report.primaryStoreBytes = stats.indices?.[manifest.physicalIndex]?.primaries?.store?.size_in_bytes ?? null;
      await client.request(`/${manifest.physicalIndex}/_mapping`, { method: "PUT", body: JSON.stringify({ _meta: {
        recall: { manifest, manifestHash: fingerprint(manifest) }, recallEvaluation: { sourceSnapshotHash: input.sourceSnapshotHash,
          assets: documents.length, chunks: report.chunks, complete: true, fullSnapshot: report.fullSnapshot },
      } }) });
      await client.request(`/${manifest.physicalIndex}/_settings`, { method: "PUT", body: JSON.stringify({ "index.blocks.write": true }) });
      report.complete = true;
    }
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, writes: undefined }));
  } catch (error) {
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally { await output.close(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Evaluation build failed; inspect its protected report. Any partially built eval index is retained for explicit cleanup, never used by live aliases.");
  process.exitCode = 1;
});
