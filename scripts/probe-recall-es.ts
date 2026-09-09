import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Synthetic data only. Never accepts an existing index name or imports the app/DB.
const index = `recall_probe_${randomUUID().replaceAll("-", "")}`;
const base = process.env.ELASTICSEARCH_URL?.replace(/\/$/, "");
assert(base, "ELASTICSEARCH_URL is required");
const headers = {
  "content-type": "application/json",
  ...(process.env.ELASTICSEARCH_USERNAME ? {
    authorization: `Basic ${Buffer.from(`${process.env.ELASTICSEARCH_USERNAME}:${process.env.ELASTICSEARCH_PASSWORD ?? ""}`).toString("base64")}`,
  } : {}),
};
async function request(path: string, method = "GET", body?: unknown, allowed: number[] = []) {
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok || allowed.includes(response.status), `ES ${method} failed: HTTP ${response.status}`);
  return { status: response.status, body: await response.json() };
}
async function main() {
const started = performance.now();
let created = false;
try {
  const cluster = await request("/");
  await request(`/${index}`, "PUT", { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: {
    assetId: { type: "keyword" }, deleted: { type: "boolean" }, contentHash: { type: "keyword" },
    chunks: { type: "nested", properties: {
      chunkId: { type: "keyword" }, text: { type: "text", analyzer: "standard" },
      embedding: { type: "dense_vector", dims: 2, index: true, similarity: "cosine" },
    } },
  } } });
  created = true;
  const documents = [
    { assetId: "a", deleted: false, contentHash: "a1", chunks: [
      { chunkId: "a1", text: "ocean beach", embedding: [1, 0] },
      { chunkId: "a2", text: "ocean waves", embedding: [0.999, 0.001] },
      { chunkId: "a3", text: "ocean sand", embedding: [0.998, 0.002] },
    ] },
    { assetId: "b", deleted: false, contentHash: "b1", chunks: [{ chunkId: "b1", text: "ocean sunset", embedding: [0.9, 0.1] }] },
    { assetId: "excluded", deleted: false, contentHash: "c1", chunks: [{ chunkId: "c1", text: "ocean beach", embedding: [1, 0] }] },
    { assetId: "deleted", deleted: true, contentHash: "d1", chunks: [{ chunkId: "d1", text: "ocean beach", embedding: [1, 0] }] },
  ];
  for (const doc of documents) await request(`/${index}/_doc/${doc.assetId}?version=1&version_type=external`, "PUT", doc);
  await request(`/${index}/_refresh`, "POST");
  const filter = [{ terms: { assetId: ["a", "b", "deleted"] } }, { term: { deleted: false } }];
  const search = await request(`/${index}/_search?allow_partial_search_results=false`, "POST", {
    size: 2, _source: ["assetId"],
    knn: { field: "chunks.embedding", query_vector: [1, 0], k: 2, num_candidates: 10,
      filter: { bool: { filter } }, inner_hits: { name: "evidence", size: 1, _source: ["chunks.chunkId", "chunks.text"] } },
  });
  assert.deepEqual(search.body.hits.hits.map((hit: { _source: { assetId: string } }) => hit._source.assetId), ["a", "b"]);
  assert.equal(search.body.hits.hits[0].inner_hits.evidence.hits.hits[0]._source.chunkId, "a1");
  const lexical = await request(`/${index}/_search?allow_partial_search_results=false`, "POST", {
    query: { bool: { filter, must: [{ nested: { path: "chunks", score_mode: "max", query: { match: { "chunks.text": "ocean" } } } }] } },
  });
  assert.equal(lexical.body.hits.hits.length, 2);
  const writeTimes: number[] = [];
  for (let revision = 2; revision <= 11; revision++) {
    const tick = performance.now();
    await request(`/${index}/_doc/a?version=${revision}&version_type=external`, "PUT", {
      ...documents[0], contentHash: `a${revision}`, chunks: [{ chunkId: "replacement", text: "mountain", embedding: [0, 1] }],
    });
    writeTimes.push(performance.now() - tick);
  }
  const replaced = await request(`/${index}/_doc/a`);
  assert.equal(replaced.body._source.chunks.length, 1);
  assert.equal(replaced.body._source.contentHash, "a11");
  const stale = await request(`/${index}/_doc/a?version=2&version_type=external`, "PUT", documents[0], [409]);
  assert.equal(stale.status, 409);
  const duplicate = await request(`/${index}/_doc/a?version=11&version_type=external`, "PUT", documents[0], [409]);
  assert.equal(duplicate.status, 409);
  const invalid = await request(`/${index}/_doc/a?version=12&version_type=external`, "PUT", {
    ...documents[0], chunks: [{ chunkId: "invalid", embedding: [1, 2, 3] }],
  }, [400]);
  assert.equal(invalid.status, 400);
  assert.equal((await request(`/${index}/_doc/a`)).body._source.contentHash, "a11");
  await request(`/${index}/_doc/a?version=12&version_type=external`, "PUT", { assetId: "a", deleted: true, contentHash: "tombstone", chunks: [] });
  assert.equal((await request(`/${index}/_doc/a?version=11&version_type=external`, "PUT", documents[0], [409])).status, 409);
  await request(`/${index}/_refresh`, "POST");
  assert.equal((await request(`/${index}/_count`, "POST", { query: { bool: { filter } } })).body.count, 1);
  const stats = await request(`/${index}/_stats/store,docs`);
  const report = {
    timestamp: new Date().toISOString(), elasticsearchVersion: cluster.body.version.number,
    checks: ["nested_parent_diversification", "top_level_scope_and_deleted_filter", "nearest_inner_hit",
      "nested_lexical_max", "full_document_replacement", "stale_version_rejected", "equal_version_rejected",
      "invalid_write_keeps_old_document", "tombstone_prevents_resurrection"],
    syntheticParentDocuments: documents.length, storeBytes: stats.body._all.primaries.store.size_in_bytes,
    writes: writeTimes.length, writeMs: { min: Math.min(...writeTimes), max: Math.max(...writeTimes),
      mean: writeTimes.reduce((sum, value) => sum + value, 0) / writeTimes.length },
    elapsedMs: performance.now() - started,
    limitations: "2-dimensional synthetic vectors; HTTP write timings exclude refresh. Not a quality or production-load benchmark.",
  };
  if (process.env.RECALL_PROBE_REPORT) await writeFile(process.env.RECALL_PROBE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (created) await request(`/${index}`, "DELETE");
}
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Recall ES probe failed");
  process.exitCode = 1;
});
