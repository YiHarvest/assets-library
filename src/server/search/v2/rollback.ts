import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/server/db/connection";
import { jobs, recallSources } from "@/server/db/schema";
import { assetSearchChunks } from "../elasticsearch";
import { fingerprint } from "./fingerprint";
import { readRecallInventory } from "./readiness";
import type { ElasticsearchClient } from "./elasticsearch";

export function compareLegacyDocuments(expected: Array<{ assetId: string; contents: string[] }>, documents: Array<{ assetId: string; content: string }>) {
  const actual = new Map<string, string[]>();
  for (const document of documents) {
    const texts = actual.get(document.assetId) ?? [];
    texts.push(document.content);
    actual.set(document.assetId, texts);
  }
  let mismatchedAssets = 0;
  for (const asset of expected) {
    if (fingerprint([...asset.contents].sort()) !== fingerprint([...(actual.get(asset.assetId) ?? [])].sort())) mismatchedAssets++;
    actual.delete(asset.assetId);
  }
  const unexpectedAssets = actual.size;
  return { mismatchedAssets, unexpectedAssets, matched: mismatchedAssets === 0 && unexpectedAssets === 0 };
}

/** v1 has no durable sourceRevision. A rollback must compare actual chunk contents
 * and bracket the scan with current-source checks, rather than trust a stale flag. */
export async function checkLegacyRollback(db: DatabaseConnection["db"], client: ElasticsearchClient, buildId: string, legacyIndex: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(legacyIndex)) throw new Error("Legacy rollback index must be a concrete environment index");
  const before = await readRecallInventory(db, buildId);
  if (!before.physicalIndex.startsWith(`${legacyIndex}_recall_v2_`)) throw new Error("Rollback index is outside the build environment");
  const pending = async () => {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.type, "embed"),
      inArray(jobs.status, ["queued", "running"]), sql`json_extract(${jobs.payload}, '$.recall') is null`));
    return Number(row.count);
  };
  const pendingBefore = await pending();
  const sources = await db.select().from(recallSources).orderBy(recallSources.assetId).limit(65537);
  if (sources.length > 65536) throw new Error("Legacy rollback inventory exceeds supported asset budget");
  const expected = sources.map((source) => ({ assetId: source.assetId,
    contents: source.deleted || !source.snapshotJson ? [] : assetSearchChunks(source.snapshotJson) }));
  const documents: Array<{ assetId: string; content: string }> = [];
  let scrollId: string | undefined;
  try {
    let response = await client.request(`/${encodeURIComponent(legacyIndex)}/_search?scroll=1m&allow_partial_search_results=false`, {
      method: "POST", body: JSON.stringify({ size: 500, _source: ["assetId", "content"], query: { match_all: {} }, sort: ["_doc"] }),
    });
    for (;;) {
      const result = await response.json();
      scrollId = result._scroll_id ?? scrollId;
      if (result.timed_out || result._shards?.failed || !Array.isArray(result.hits?.hits)) throw new Error("Legacy index scan failed");
      if (!result.hits.hits.length) break;
      for (const hit of result.hits.hits) {
        if (typeof hit._source?.assetId !== "string" || typeof hit._source?.content !== "string") throw new Error("Legacy index contains an unsupported document");
        documents.push({ assetId: hit._source.assetId, content: hit._source.content });
      }
      if (documents.length > 1_000_000 || !scrollId) throw new Error("Legacy index scan exceeds supported budget or lacks a cursor");
      response = await client.request("/_search/scroll", { method: "POST", body: JSON.stringify({ scroll: "1m", scroll_id: scrollId }) });
    }
  } finally {
    if (scrollId) await client.request("/_search/scroll", { method: "DELETE", body: JSON.stringify({ scroll_id: [scrollId] }) });
  }
  const after = await readRecallInventory(db, buildId);
  const comparison = compareLegacyDocuments(expected, documents);
  const pendingAfter = await pending();
  const blockers = [
    ...(!comparison.matched ? ["legacy_content_mismatch"] : []),
    ...(fingerprint(before) !== fingerprint(after) ? ["source_changed_during_check"] : []),
    ...(after.currentSourceMismatches ? ["source_snapshot_mismatch"] : []),
    ...(!after.backfillComplete || !after.writeEnabled ? ["dual_write_or_backfill_incomplete"] : []),
    ...(pendingBefore || pendingAfter ? ["legacy_writes_in_flight"] : []),
  ];
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), legacyIndex, buildId, ready: blockers.length === 0, blockers,
    sourceInventoryHash: fingerprint(after), ...comparison, indexedChunks: documents.length, pendingBefore, pendingAfter,
    environmentChanges: { SEARCH_RECALL_ENGINE: "v1", SEARCH_V2_WRITE_ENABLED: "true" },
    limitation: "A point-in-time check cannot version v1 writes. Keep legacy workers and dual writes healthy throughout the rollback observation period." };
}
