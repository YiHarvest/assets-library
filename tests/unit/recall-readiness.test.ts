import { describe, expect, it } from "vitest";
import { assessRecallReadiness, type RecallInventory } from "@/server/search/v2/readiness";
import { fingerprint } from "@/server/search/v2/fingerprint";
import { manifest } from "../helpers/recall";

const inventory = (): RecallInventory => ({ buildId: manifest.buildId, physicalIndex: manifest.physicalIndex,
  manifestHash: fingerprint(manifest), writeEnabled: true, backfillComplete: true, currentSourceMismatches: 0,
  sources: [{ assetId: "a", sourceRevision: 2, sourceHash: "c".repeat(64), deleted: false }],
  states: [{ assetId: "a", desiredRevision: 2, indexedRevision: 2, contentHash: "d".repeat(64), status: "done" }] });
describe("recall build readiness", () => {
  it("checks parent IDs, hashes, revisions and tombstones instead of nested Lucene counts", () => {
    const before = inventory();
    const docs = [{ assetId: "a", sourceRevision: 2, contentHash: "d".repeat(64), deleted: false }];
    const ready = assessRecallReadiness(before, structuredClone(before), docs, 1);
    expect(ready.ready).toBe(true);
    expect(ready.activeAssets).toBe(1);
    expect(assessRecallReadiness(before, before, docs, 8).blockers).toContain("parent_count_mismatch");
    expect(assessRecallReadiness(before, before, [{ ...docs[0], sourceRevision: 1 }], 1).blockers).toContain("index_document_mismatch");
    const deleted = structuredClone(before);
    deleted.sources[0].deleted = true;
    deleted.states[0].status = "deleted";
    expect(assessRecallReadiness(deleted, deleted, docs, 1).ready).toBe(false);
    expect(assessRecallReadiness(deleted, deleted, [{ ...docs[0], deleted: true }], 1)).toMatchObject({ ready: true, activeAssets: 0, tombstones: 1 });
  });
  it("blocks drift, stale snapshots, incomplete backfill and unapplied current revisions", () => {
    const before = inventory(), after = inventory();
    after.sources[0].sourceRevision++;
    after.currentSourceMismatches = 1;
    after.backfillComplete = false;
    const result = assessRecallReadiness(before, after, [], 0);
    expect(result.blockers).toEqual(expect.arrayContaining(["source_changed_during_check", "source_snapshot_mismatch", "backfill_incomplete", "build_not_caught_up"]));
    expect(result.ready).toBe(false);
  });
});
