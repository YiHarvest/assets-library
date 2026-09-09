import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "@/server/db/connection";
import { analysisResultEntries, assetEntries, assetTagEntries, recallBuilds, recallBuildState, recallSources, tags } from "@/server/db/schema";
import { analysisResultSchema, type AssetTag } from "@/shared/contracts";
import { fingerprint } from "./fingerprint";
import { readSearchManifest, type ElasticsearchClient } from "./elasticsearch";

export interface RecallInventory {
  buildId: string; physicalIndex: string; manifestHash: string; writeEnabled: boolean; backfillComplete: boolean;
  currentSourceMismatches: number;
  sources: Array<{ assetId: string; sourceRevision: number; sourceHash: string; deleted: boolean }>;
  states: Array<{ assetId: string; desiredRevision: number; indexedRevision: number | null; contentHash: string | null; status: string }>;
}
export interface IndexedRecallIdentity { assetId: string; sourceRevision: number; contentHash: string; deleted: boolean }

/** Two consistent, read-only inventories bracket the ES checks. No migration, queue
 * repair, media reads, embeddings, asset mutations or application singleton imports. */
export async function readRecallInventory(db: DatabaseConnection["db"], buildId: string): Promise<RecallInventory> {
  return db.transaction(async (tx) => {
    const [build] = await tx.select().from(recallBuilds).where(eq(recallBuilds.buildId, buildId));
    if (!build || fingerprint(build.manifestJson) !== build.manifestHash) throw new Error("Missing or invalid recall build manifest");
    const sources = await tx.select().from(recallSources).orderBy(recallSources.assetId).limit(65537);
    const states = await tx.select().from(recallBuildState).where(eq(recallBuildState.buildId, buildId)).orderBy(recallBuildState.assetId).limit(65537);
    const current = await tx.select({ id: assetEntries.id, kind: assetEntries.kind, name: assetEntries.name, description: assetEntries.description,
      deletedAt: assetEntries.deletedAt, reviewStatus: assetEntries.reviewStatus,
      segmentStartMs: assetEntries.segmentStartMs, segmentEndMs: assetEntries.segmentEndMs }).from(assetEntries).limit(65537);
    if (Math.max(sources.length, states.length, current.length) > 65536) throw new Error("Readiness inventory exceeds supported asset budget");
    const analyses = await tx.select({ assetId: analysisResultEntries.assetId, kind: analysisResultEntries.kind, result: analysisResultEntries.resultJson })
      .from(analysisResultEntries).limit(65537);
    const links = await tx.select({ assetId: assetTagEntries.assetId, category: tags.category, value: tags.value, source: assetTagEntries.source })
      .from(assetTagEntries).innerJoin(tags, eq(assetTagEntries.tagId, tags.id)).orderBy(tags.category, tags.value, assetTagEntries.source).limit(1_000_001);
    if (analyses.length > 65536 || links.length > 1_000_000) throw new Error("Readiness metadata exceeds supported inventory budget");
    const analysisById = new Map(analyses.map((row) => [`${row.kind}:${row.assetId}`, row.result]));
    const tagsById = new Map<string, AssetTag[]>();
    for (const link of links) {
      const list = tagsById.get(link.assetId) ?? [];
      list.push({ category: link.category, value: link.value, source: link.source });
      tagsById.set(link.assetId, list);
    }
    const sourceById = new Map(sources.map((source) => [source.assetId, source]));
    const currentIds = new Set(current.map((row) => row.id));
    let mismatches = 0;
    for (const row of current) {
      const source = sourceById.get(row.id);
      const deleted = Boolean(row.deletedAt || row.reviewStatus === "deleted");
      const raw = analysisById.get(`${row.kind}:${row.id}`);
      const snapshot = deleted ? null : { id: row.id, name: row.name, description: row.description,
        analysis: raw ? analysisResultSchema.parse(raw) : null, tags: tagsById.get(row.id) ?? [],
        segmentStartMs: row.segmentStartMs, segmentEndMs: row.segmentEndMs };
      if (!source || source.assetKind !== row.kind || source.sourceHash !== fingerprint({ ref: { id: row.id, kind: row.kind }, deleted, snapshot })) mismatches++;
    }
    for (const source of sources) {
      if (!currentIds.has(source.assetId) && !source.deleted) mismatches++;
      if (source.sourceHash !== fingerprint({ ref: { id: source.assetId, kind: source.assetKind }, deleted: source.deleted, snapshot: source.snapshotJson })) mismatches++;
    }
    return { buildId, physicalIndex: build.physicalIndex, manifestHash: build.manifestHash, writeEnabled: build.writeEnabled,
      backfillComplete: Boolean(build.backfillCompletedAt), currentSourceMismatches: mismatches,
      sources: sources.map(({ assetId, sourceRevision, sourceHash, deleted }) => ({ assetId, sourceRevision, sourceHash, deleted })),
      states: states.map(({ assetId, desiredRevision, indexedRevision, contentHash, status }) => ({ assetId, desiredRevision, indexedRevision, contentHash, status })) };
  // First consistent SELECT establishes the REPEATABLE READ snapshot. Drizzle
  // 0.44 emits invalid MySQL syntax if both START modifiers are requested.
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function assessRecallReadiness(before: RecallInventory, after: RecallInventory, documents: IndexedRecallIdentity[], parentCount: number) {
  const blockers: string[] = [];
  if (fingerprint(before) !== fingerprint(after)) blockers.push("source_changed_during_check");
  if (!after.writeEnabled) blockers.push("dual_write_disabled");
  if (!after.backfillComplete) blockers.push("backfill_incomplete");
  if (after.currentSourceMismatches) blockers.push("source_snapshot_mismatch");
  const states = new Map(after.states.map((state) => [state.assetId, state]));
  const docs = new Map(documents.map((document) => [document.assetId, document]));
  if (parentCount !== after.sources.length || docs.size !== documents.length) blockers.push("parent_count_mismatch");
  if (states.size !== after.sources.length) blockers.push("build_state_count_mismatch");
  let lagging = 0, mismatched = 0;
  for (const source of after.sources) {
    const state = states.get(source.assetId), document = docs.get(source.assetId);
    if (!state || state.desiredRevision !== source.sourceRevision || state.indexedRevision !== source.sourceRevision || !state.contentHash ||
      state.status !== (source.deleted ? "deleted" : "done")) lagging++;
    if (!document || document.sourceRevision !== source.sourceRevision || document.contentHash !== state?.contentHash || document.deleted !== source.deleted) mismatched++;
  }
  if (lagging) blockers.push("build_not_caught_up");
  if (mismatched) blockers.push("index_document_mismatch");
  return { schemaVersion: 1 as const, checkedAt: new Date().toISOString(), buildId: after.buildId, physicalIndex: after.physicalIndex,
    manifestHash: after.manifestHash, sourceInventoryHash: fingerprint(after), ready: blockers.length === 0, blockers,
    activeAssets: after.sources.filter((source) => !source.deleted).length, tombstones: after.sources.filter((source) => source.deleted).length,
    parentCount, lagging, mismatched, currentSourceMismatches: after.currentSourceMismatches };
}

export async function checkRecallReadiness(db: DatabaseConnection["db"], client: ElasticsearchClient, buildId: string) {
  const before = await readRecallInventory(db, buildId);
  if (fingerprint(await readSearchManifest(client, before.physicalIndex)) !== before.manifestHash) throw new Error("ES and MySQL build manifests differ");
  const documents: IndexedRecallIdentity[] = [];
  for (let offset = 0; offset < before.sources.length; offset += 100) {
    const response = await client.request(`/${encodeURIComponent(before.physicalIndex)}/_mget?_source_includes=assetId,sourceRevision,contentHash,deleted`, { method: "POST", body: JSON.stringify({
      ids: before.sources.slice(offset, offset + 100).map((source) => source.assetId),
    }) });
    const result = await response.json();
    if (!Array.isArray(result.docs) || result.docs.some((doc: { error?: unknown }) => doc.error)) throw new Error("ES inventory returned an error");
    for (const doc of result.docs) if (doc.found) {
      // Read source identity only; vectors never enter reports or normal logs.
      if (doc._id !== doc._source?.assetId || doc._version !== doc._source?.sourceRevision) throw new Error("ES document identity is inconsistent");
      documents.push({ assetId: doc._source.assetId, sourceRevision: doc._source.sourceRevision,
        contentHash: doc._source.contentHash, deleted: doc._source.deleted });
    }
  }
  // _count counts root search documents; _stats.docs includes nested Lucene docs.
  const response = await client.request(`/${encodeURIComponent(before.physicalIndex)}/_count`);
  const count = await response.json();
  if (count._shards?.failed || !Number.isSafeInteger(count.count)) throw new Error("ES parent count is incomplete");
  return assessRecallReadiness(before, await readRecallInventory(db, buildId), documents, count.count);
}
