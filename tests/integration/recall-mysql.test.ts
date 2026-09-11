import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { initializeDatabase } from "@/server/db/migrations";
import type { DatabaseConnection } from "@/server/db/connection";
import * as schema from "@/server/db/schema";
import { enqueueRecallSource, loadRecallWork, parseRecallJob, recordRecallFailure, recordRecallSuccess, registerRecallBuild } from "@/server/search/v2/repository";
import { bindIntegrationDatabaseEnvironment, truncateIntegrationTables } from "../helpers/integration-database";
import { manifest as fixture } from "../helpers/recall";
import { tokenizer } from "../helpers/recall";
import { ElasticsearchClient, createSearchIndex, searchDocumentStore } from "@/server/search/v2/elasticsearch";
import { executeRecallJob } from "@/server/search/v2/index-job";
import { backfillRecallBatch, restartRecallBackfill } from "@/server/search/v2/backfill";
import { checkRecallReadiness, readRecallInventory } from "@/server/search/v2/readiness";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("recall revisions and durable build jobs in MySQL", () => {
  let connection: DatabaseConnection;
  beforeAll(async () => {
    // Vitest already maps DATABASE_URL from TEST_DATABASE_URL; use the shared
    // mode-aware guard before any connection or cleanup, as the other DB suites do.
    bindIntegrationDatabaseEnvironment(url!);
    connection = await initializeDatabase({ url: url!, sslCaPath: process.env.DATABASE_SSL_CA_PATH || undefined, poolSize: 4 });
    await truncateIntegrationTables(connection.pool);
  }, 30_000);
  beforeEach(async () => { await truncateIntegrationTables(connection.pool); });
  afterAll(async () => {
    if (connection) {
      await truncateIntegrationTables(connection.pool);
      await connection.pool.end();
    }
  });

  it("resumes keyset backfill, includes retained tombstones, and reconciles IDs inserted behind the cursor", async () => {
    const manifest = { ...fixture, buildId: "backfill", physicalIndex: "test_recall_v2_backfill" };
    await registerRecallBuild(connection.db, manifest);
    const ids = ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"];
    const now = new Date();
    const insert = async (id: string) => connection.db.insert(schema.publicAssets).values({ id, name: "backfill", description: "海边日出",
      mediaType: "image", originalFilename: "legacy.png", originalPath: "legacy.png", mimeType: "image/png", sizeBytes: 4,
      processingStatus: "completed", reviewStatus: "published", createdAt: now, updatedAt: now });
    await insert(ids[1]); await insert(ids[2]);
    expect(await backfillRecallBatch(connection.db, manifest.buildId, 1)).toMatchObject({ processed: 1, completed: false, cursor: ids[1] });
    await insert(ids[0]);
    await connection.db.transaction((tx) => enqueueRecallSource(tx, { id: ids[0], kind: "public" }));
    await connection.db.transaction(async (tx) => {
      await enqueueRecallSource(tx, { id: ids[2], kind: "public" }, { deleted: true });
      await tx.delete(schema.publicAssets).where(eq(schema.publicAssets.id, ids[2]));
    });
    expect(await backfillRecallBatch(connection.db, manifest.buildId, 2)).toMatchObject({ processed: 1, completed: true, cursor: ids[2] });
    const before = await connection.db.select().from(schema.jobs);
    expect(before).toHaveLength(3);
    await restartRecallBackfill(connection.db, manifest.buildId);
    expect(await backfillRecallBatch(connection.db, manifest.buildId, 10)).toMatchObject({ processed: 3, completed: true });
    expect(await connection.db.select().from(schema.jobs)).toHaveLength(3);
    expect((await connection.db.select().from(schema.recallSources)).map((row) => row.sourceRevision)).toEqual([1, 1, 1]);
    expect((await readRecallInventory(connection.db, manifest.buildId)).currentSourceMismatches).toBe(0);
    await connection.db.update(schema.publicAssets).set({ description: "模拟漏掉索引入队的更新" }).where(eq(schema.publicAssets.id, ids[0]));
    expect((await readRecallInventory(connection.db, manifest.buildId)).currentSourceMismatches).toBe(1);
    await restartRecallBackfill(connection.db, manifest.buildId);
    await backfillRecallBatch(connection.db, manifest.buildId);
    expect((await readRecallInventory(connection.db, manifest.buildId)).currentSourceMismatches).toBe(0);
    await connection.db.update(schema.recallBuilds).set({ writeEnabled: false }).where(eq(schema.recallBuilds.buildId, manifest.buildId));
    await expect(backfillRecallBatch(connection.db, manifest.buildId)).rejects.toThrow(/双写/);
  }, 30_000);

  it("commits each snapshot with its revision and jobs, rolls back together, and retains deletion after cascade", async () => {
    const now = new Date();
    const assetId = randomUUID();
    const manifest = { ...fixture, buildId: randomUUID(), physicalIndex: `test_recall_v2_${randomUUID().replaceAll("-", "")}` };
    await registerRecallBuild(connection.db, manifest);
    await connection.db.insert(schema.publicAssets).values({ id: assetId, name: "initial", description: "海边日出",
      mediaType: "image", originalFilename: "legacy.png", originalPath: "legacy.png", mimeType: "image/png", sizeBytes: 4,
      processingStatus: "completed", reviewStatus: "published", createdAt: now, updatedAt: now });
    const ref = { id: assetId, kind: "public" as const };
    await connection.db.transaction((tx) => enqueueRecallSource(tx, ref));
    let [state] = await connection.db.select().from(schema.recallSources).where(eq(schema.recallSources.assetId, assetId));
    expect(state).toMatchObject({ sourceRevision: 1, deleted: false });
    await expect(connection.db.transaction(async (tx) => {
      await tx.update(schema.publicAssets).set({ description: "must roll back" }).where(eq(schema.publicAssets.id, assetId));
      await enqueueRecallSource(tx, ref);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    [state] = await connection.db.select().from(schema.recallSources).where(eq(schema.recallSources.assetId, assetId));
    expect(state.sourceRevision).toBe(1);
    expect(state.snapshotJson?.description).toBe("海边日出");
    await connection.db.transaction(async (tx) => {
      await tx.update(schema.publicAssets).set({ description: "new description" }).where(eq(schema.publicAssets.id, assetId));
      await enqueueRecallSource(tx, ref);
    });
    await connection.db.transaction(async (tx) => {
      await enqueueRecallSource(tx, ref, { deleted: true });
      await tx.delete(schema.publicAssets).where(eq(schema.publicAssets.id, assetId));
    });
    [state] = await connection.db.select().from(schema.recallSources).where(eq(schema.recallSources.assetId, assetId));
    expect(state).toMatchObject({ sourceRevision: 3, deleted: true, snapshotJson: null });
    const jobs = await connection.db.select().from(schema.jobs);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.payload?.recall)).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId, sourceRevision: 1, buildId: manifest.buildId, physicalIndex: manifest.physicalIndex }),
      expect.objectContaining({ assetId, sourceRevision: 3, deleted: true }),
    ]));
    expect(jobs.every((job) => job.publicAssetId === null && job.privateAssetId === null && job.taskId === null)).toBe(true);
  }, 30_000);

  it("keeps a separate watermark per build and serializes simultaneous edits without duplicate backfill jobs", async () => {
    const now = new Date();
    const assetId = randomUUID();
    const first = { ...fixture, buildId: "first", physicalIndex: "test_recall_v2_first" };
    const second = { ...fixture, buildId: "second", physicalIndex: "test_recall_v2_second" };
    await registerRecallBuild(connection.db, first);
    await connection.db.insert(schema.publicAssets).values({ id: assetId, name: "initial", description: "initial",
      mediaType: "image", originalFilename: "legacy.png", originalPath: "legacy.png", mimeType: "image/png", sizeBytes: 4,
      processingStatus: "completed", reviewStatus: "published", createdAt: now, updatedAt: now });
    const ref = { id: assetId, kind: "public" as const };
    await connection.db.transaction((tx) => enqueueRecallSource(tx, ref));
    await registerRecallBuild(connection.db, second);
    await connection.db.transaction((tx) => enqueueRecallSource(tx, ref, { buildId: second.buildId }));
    await connection.db.transaction((tx) => enqueueRecallSource(tx, ref, { buildId: second.buildId }));
    expect(await connection.db.select().from(schema.jobs)).toHaveLength(2);
    await Promise.all(["edit one", "edit two"].map((description) => connection.db.transaction(async (tx) => {
      await tx.update(schema.publicAssets).set({ description }).where(eq(schema.publicAssets.id, assetId));
      return enqueueRecallSource(tx, ref);
    })));
    const [state] = await connection.db.select().from(schema.recallSources).where(eq(schema.recallSources.assetId, assetId));
    expect(state.sourceRevision).toBe(3);
    const pending = await connection.db.select().from(schema.recallBuildState);
    expect(pending).toHaveLength(2);
    expect(pending.every((item) => item.desiredRevision === 3 && item.indexedRevision === null)).toBe(true);
    const queued = await connection.db.select().from(schema.jobs);
    expect(queued).toHaveLength(6);
    for (const buildId of [first.buildId, second.buildId]) {
      expect(queued.map((job) => job.payload?.recall).filter((payload) => (payload as { buildId: string }).buildId === buildId)
        .map((payload) => (payload as { sourceRevision: number }).sourceRevision).sort()).toEqual([1, 2, 3]);
    }
    const firstJobs = queued.map((job) => parseRecallJob(job.payload?.recall)).filter((job) => job.buildId === first.buildId);
    const old = firstJobs.find((job) => job.sourceRevision === 1)!;
    const latest = firstJobs.find((job) => job.sourceRevision === 3)!;
    expect(await loadRecallWork(connection.db, old)).toBeNull();
    expect((await loadRecallWork(connection.db, latest))?.snapshot?.description).toBe(state.snapshotJson?.description);
    await recordRecallSuccess(connection.db, latest, "c".repeat(64));
    await recordRecallFailure(connection.db, old, "late failure");
    await recordRecallSuccess(connection.db, old, "d".repeat(64));
    const watermarks = await connection.db.select().from(schema.recallBuildState);
    expect(watermarks.find((item) => item.buildId === first.buildId)).toMatchObject({ desiredRevision: 3, indexedRevision: 3,
      status: "done", contentHash: "c".repeat(64), errorMessage: null });
    expect(watermarks.find((item) => item.buildId === second.buildId)).toMatchObject({ desiredRevision: 3, indexedRevision: null, status: "queued" });
  }, 30_000);

  it.skipIf(!process.env.TEST_RECALL_ES_URL)("runs committed snapshots through real ES, retries failure and deletes after the asset row is gone", async () => {
    const now = new Date();
    const assetId = randomUUID();
    const manifest = { ...fixture, buildId: randomUUID(), physicalIndex: `test_recall_v2_${randomUUID().replaceAll("-", "")}` };
    const client = new ElasticsearchClient({ url: process.env.TEST_RECALL_ES_URL!, username: process.env.TEST_RECALL_ES_USERNAME,
      password: process.env.TEST_RECALL_ES_PASSWORD, timeoutMs: 30_000 });
    await createSearchIndex(client, manifest);
    try {
      await registerRecallBuild(connection.db, manifest);
      await connection.db.insert(schema.publicAssets).values({ id: assetId, name: "test", description: "海边日出",
        mediaType: "image", originalFilename: "legacy.png", originalPath: "legacy.png", mimeType: "image/png", sizeBytes: 4,
        processingStatus: "completed", reviewStatus: "published", createdAt: now, updatedAt: now });
      const ref = { id: assetId, kind: "public" as const };
      const store = searchDocumentStore(client, manifest);
      const embed = vi.fn(async (texts: Array<{ text: string }>) => texts.map(() => [1, 0]));
      const runtime = async () => ({ client, store, embed, tokenizer: { ...tokenizer, encode: () => [] } });
      const queued = async (revision: number) => {
        const rows = await connection.db.select().from(schema.jobs);
        return rows.map((row) => parseRecallJob(row.payload?.recall)).find((job) => job.sourceRevision === revision)!;
      };
      await connection.db.transaction((tx) => enqueueRecallSource(tx, ref));
      expect(await executeRecallJob(connection.db, await queued(1), runtime)).toMatchObject({ status: "written" });
      await connection.db.transaction(async (tx) => {
        await tx.update(schema.publicAssets).set({ description: "新的海边内容" }).where(eq(schema.publicAssets.id, assetId));
        await enqueueRecallSource(tx, ref);
      });
      embed.mockRejectedValueOnce(new Error("temporary model failure"));
      const second = await queued(2);
      await expect(executeRecallJob(connection.db, second, runtime)).rejects.toThrow("temporary model failure");
      expect((await store.read(assetId))?.version).toBe(1);
      expect(await executeRecallJob(connection.db, second, runtime)).toMatchObject({ status: "written" });
      await connection.db.transaction(async (tx) => {
        await enqueueRecallSource(tx, ref, { deleted: true });
        await tx.delete(schema.publicAssets).where(eq(schema.publicAssets.id, assetId));
      });
      await executeRecallJob(connection.db, await queued(3), runtime);
      expect(await executeRecallJob(connection.db, second, runtime)).toMatchObject({ status: "superseded" });
      expect((await store.read(assetId))?.document).toMatchObject({ deleted: true, sourceRevision: 3, chunks: [] });
      const [watermark] = await connection.db.select().from(schema.recallBuildState);
      expect(watermark).toMatchObject({ desiredRevision: 3, indexedRevision: 3, status: "deleted" });
      expect(await connection.db.select().from(schema.publicAssets)).toHaveLength(0);
      await backfillRecallBatch(connection.db, manifest.buildId);
      expect(await checkRecallReadiness(connection.db, client, manifest.buildId)).toMatchObject({ ready: true, activeAssets: 0, tombstones: 1, parentCount: 1 });
    } finally { await client.request(`/${manifest.physicalIndex}`, { method: "DELETE" }); }
  }, 30_000);
});
