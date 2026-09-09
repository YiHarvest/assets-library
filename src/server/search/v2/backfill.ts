import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DatabaseConnection } from "@/server/db/connection";
import { assetEntries, recallBuilds, recallSources } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { enqueueRecallSource } from "./repository";

/** Keyset progress is committed only after every source transaction in the batch.
 * Replaying an interrupted batch is idempotent. No source rows are edited here.
 * Live writers must already enqueue mutations before starting the first batch. */
export async function backfillRecallBatch(db: DatabaseConnection["db"], buildId: string, batchSize = 100) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error("Backfill batch size must be between 1 and 200");
  const [build] = await db.select().from(recallBuilds).where(eq(recallBuilds.buildId, buildId));
  if (!build || !build.writeEnabled) throw new AppError("storage_error", "回填目标不存在或未启用持久双写。", 409);
  if (build.backfillCompletedAt) return { processed: 0, completed: true, cursor: build.backfillCursor };
  // Include retained tombstones whose original asset row has already disappeared.
  const [current, retained] = await Promise.all([
    db.select({ id: assetEntries.id, kind: assetEntries.kind }).from(assetEntries)
      .where(build.backfillCursor ? gt(assetEntries.id, build.backfillCursor) : undefined).orderBy(asc(assetEntries.id)).limit(batchSize),
    db.select({ id: recallSources.assetId, kind: recallSources.assetKind }).from(recallSources)
      .where(build.backfillCursor ? gt(recallSources.assetId, build.backfillCursor) : undefined).orderBy(asc(recallSources.assetId)).limit(batchSize),
  ]);
  const identities = new Map<string, typeof current[number]>();
  for (const row of [...current, ...retained]) {
    if (identities.has(row.id) && identities.get(row.id)!.kind !== row.kind) throw new AppError("storage_error", "回填素材身份冲突。", 409);
    identities.set(row.id, row);
  }
  const batch = [...identities.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, batchSize);
  for (const ref of batch) await db.transaction((tx) => enqueueRecallSource(tx, ref, { buildId }));
  const cursor = batch.at(-1)?.id ?? build.backfillCursor;
  // A short union page proves end-of-scan at this point; subsequent inserts are
  // covered by live dual writes, including UUIDs lexically behind the cursor.
  const completed = batch.length < batchSize;
  const [result] = await db.update(recallBuilds).set({ backfillCursor: cursor,
    backfillCompletedAt: completed ? new Date() : null, updatedAt: new Date() }).where(and(
    eq(recallBuilds.buildId, buildId), eq(recallBuilds.writeEnabled, true), isNull(recallBuilds.backfillCompletedAt),
    build.backfillCursor ? eq(recallBuilds.backfillCursor, build.backfillCursor) : isNull(recallBuilds.backfillCursor),
  ));
  if (result.affectedRows !== 1) throw new AppError("storage_error", "回填游标已被其他进程修改；本批可安全重试。", 409);
  return { processed: batch.length, completed, cursor };
}

/** Explicit reconciliation sweep. Previously queued jobs remain pinned and valid. */
export async function restartRecallBackfill(db: DatabaseConnection["db"], buildId: string) {
  const [result] = await db.update(recallBuilds).set({ backfillCursor: null, backfillCompletedAt: null,
    status: sql`case when ${recallBuilds.status} = 'active' then 'active' else 'building' end`, updatedAt: new Date() })
    .where(and(eq(recallBuilds.buildId, buildId), eq(recallBuilds.writeEnabled, true)));
  if (result.affectedRows !== 1) throw new AppError("storage_error", "无法重新扫描指定召回构建。", 409);
}
