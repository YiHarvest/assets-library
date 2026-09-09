import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseConnection } from "@/server/db/connection";
import { analysisResults, assetTags, jobs, privateAssets, publicAssets, recallBuilds, recallBuildState, recallSources, tags } from "@/server/db/schema";
import { analysisResultSchema } from "@/shared/contracts";
import { AppError } from "@/server/errors";
import { fingerprint } from "./fingerprint";
import { parseSearchManifest } from "./manifest";
import type { SearchAssetSource, SearchBuildManifest } from "./types";

type Database = DatabaseConnection["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
interface AssetReference { id: string; kind: "public" | "private" }

export interface RecallJobPayload {
  schemaVersion: 2;
  assetId: string;
  assetKind: "public" | "private";
  sourceRevision: number;
  buildId: string;
  physicalIndex: string;
  manifestHash: string;
  deleted: boolean;
}

export async function registerRecallBuild(db: Database, manifest: SearchBuildManifest) {
  parseSearchManifest(manifest);
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(recallBuilds).ignore().values({ buildId: manifest.buildId, physicalIndex: manifest.physicalIndex,
      manifestJson: manifest, manifestHash: fingerprint(manifest), writeEnabled: true, status: "building", createdAt: now, updatedAt: now });
    const [stored] = await tx.select().from(recallBuilds).where(eq(recallBuilds.buildId, manifest.buildId)).for("update");
    if (!stored || stored.manifestHash !== fingerprint(manifest) || stored.physicalIndex !== manifest.physicalIndex) {
      throw new AppError("storage_error", "召回构建 ID 或物理索引已绑定不同清单。", 409);
    }
    return stored;
  });
}

/** Caller and backfill share the same asset-first locking order. Locking reads bypass
 * an older REPEATABLE READ snapshot if this transaction waited for a concurrent edit. */
async function lockSource(tx: Transaction, ref: AssetReference, deleted: boolean): Promise<SearchAssetSource | null> {
  const [asset] = ref.kind === "public"
    ? await tx.select().from(publicAssets).where(eq(publicAssets.id, ref.id)).for("update")
    : await tx.select().from(privateAssets).where(eq(privateAssets.id, ref.id)).for("update");
  if (deleted || !asset || asset.deletedAt || asset.reviewStatus === "deleted") return null;
  const [analysis] = await tx.select({ result: analysisResults.resultJson }).from(analysisResults)
    .where(ref.kind === "public" ? eq(analysisResults.publicAssetId, ref.id) : eq(analysisResults.privateAssetId, ref.id)).for("share");
  const currentTags = await tx.select({ category: tags.category, value: tags.value, source: assetTags.source })
    .from(assetTags).innerJoin(tags, eq(assetTags.tagId, tags.id))
    .where(ref.kind === "public" ? eq(assetTags.publicAssetId, ref.id) : eq(assetTags.privateAssetId, ref.id))
    .orderBy(tags.category, tags.value, assetTags.source).for("share");
  return { id: asset.id, name: asset.name, description: asset.description,
    analysis: analysis ? analysisResultSchema.parse(analysis.result) : null, tags: currentTags,
    segmentStartMs: asset.segmentStartMs, segmentEndMs: asset.segmentEndMs };
}

/** Call in the same transaction as a content mutation, before any hard delete. */
export async function enqueueRecallSource(tx: Transaction, ref: AssetReference, options: { deleted?: boolean; buildId?: string } = {}) {
  const snapshot = await lockSource(tx, ref, options.deleted ?? false);
  const deleted = snapshot === null;
  const sourceHash = fingerprint({ ref, deleted, snapshot });
  const now = new Date();
  // No asset FK: revision and tombstone survive deletion, along with their jobs.
  await tx.insert(recallSources).ignore().values({ assetId: ref.id, assetKind: ref.kind, sourceRevision: 0,
    sourceHash: "", deleted, snapshotJson: snapshot, updatedAt: now });
  const [previous] = await tx.select().from(recallSources).where(eq(recallSources.assetId, ref.id)).for("update");
  if (!previous || previous.assetKind !== ref.kind) throw new AppError("storage_error", "召回素材身份冲突。", 409);
  const revision = previous.sourceHash === sourceHash ? previous.sourceRevision : previous.sourceRevision + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AppError("storage_error", "召回素材版本超出支持范围。", 500);
  await tx.update(recallSources).set({ sourceRevision: revision, sourceHash, deleted, snapshotJson: snapshot, updatedAt: now })
    .where(eq(recallSources.assetId, ref.id));
  const builds = await tx.select().from(recallBuilds).where(and(eq(recallBuilds.writeEnabled, true),
    options.buildId && previous.sourceHash === sourceHash ? eq(recallBuilds.buildId, options.buildId) : undefined)).for("share");
  for (const build of builds) {
    const predicate = and(eq(recallBuildState.buildId, build.buildId), eq(recallBuildState.assetId, ref.id));
    const [state] = await tx.select().from(recallBuildState).where(predicate).for("update");
    if (state && state.desiredRevision >= revision && state.status !== "failed") continue;
    await tx.insert(recallBuildState).values({ buildId: build.buildId, assetId: ref.id, desiredRevision: revision, status: "queued", updatedAt: now })
      .onDuplicateKeyUpdate({ set: { desiredRevision: revision, status: "queued", errorMessage: null, updatedAt: now } });
    const payload: RecallJobPayload = { schemaVersion: 2, assetId: ref.id, assetKind: ref.kind, sourceRevision: revision,
      buildId: build.buildId, physicalIndex: build.physicalIndex, manifestHash: build.manifestHash, deleted };
    await tx.insert(jobs).values({ id: crypto.randomUUID(), type: "embed", status: "queued", phase: "analyzing",
      payload: { recall: payload }, availableAt: now, createdAt: now, updatedAt: now });
  }
  return { assetId: ref.id, sourceRevision: revision, deleted };
}

const jobSchema = z.object({ schemaVersion: z.literal(2), assetId: z.string().uuid(), assetKind: z.enum(["public", "private"]),
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), buildId: z.string().min(1), physicalIndex: z.string().min(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/), deleted: z.boolean() }).strict();

export function parseRecallJob(value: unknown): RecallJobPayload { return jobSchema.parse(value); }

export async function loadRecallWork(db: Database, job: RecallJobPayload) {
  return db.transaction(async (tx) => {
    const [build] = await tx.select().from(recallBuilds).where(eq(recallBuilds.buildId, job.buildId)).for("share");
    if (!build || build.physicalIndex !== job.physicalIndex || build.manifestHash !== job.manifestHash ||
      fingerprint(build.manifestJson) !== job.manifestHash) throw new AppError("storage_error", "召回作业目标构建与持久清单不一致。", 503);
    const [source] = await tx.select().from(recallSources).where(eq(recallSources.assetId, job.assetId)).for("share");
    if (!source || source.assetKind !== job.assetKind || source.sourceRevision < job.sourceRevision) {
      throw new AppError("storage_error", "召回作业的持久来源版本缺失。", 503);
    }
    if (source.sourceRevision > job.sourceRevision) return null;
    if (source.deleted !== job.deleted || (!source.deleted && !source.snapshotJson)) {
      throw new AppError("storage_error", "召回来源快照与作业版本不一致。", 503);
    }
    await tx.update(recallBuildState).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(recallBuildState.buildId, job.buildId), eq(recallBuildState.assetId, job.assetId),
      eq(recallBuildState.desiredRevision, job.sourceRevision),
      or(isNull(recallBuildState.indexedRevision), lt(recallBuildState.indexedRevision, job.sourceRevision)),
    ));
    return { manifest: parseSearchManifest(build.manifestJson), snapshot: source.snapshotJson };
  });
}

export async function recordRecallSuccess(db: Database, job: RecallJobPayload, contentHash: string) {
  const now = new Date();
  await db.update(recallBuildState).set({ indexedRevision: job.sourceRevision, contentHash, indexedAt: now, updatedAt: now,
    errorMessage: null,
    status: sql`case when ${recallBuildState.desiredRevision} = ${job.sourceRevision} then ${job.deleted ? "deleted" : "done"} else 'queued' end`,
  }).where(and(eq(recallBuildState.buildId, job.buildId), eq(recallBuildState.assetId, job.assetId),
    or(isNull(recallBuildState.indexedRevision), lt(recallBuildState.indexedRevision, job.sourceRevision))));
}

export async function recordRecallFailure(db: Database, job: RecallJobPayload, message: string) {
  await db.update(recallBuildState).set({ status: "failed", errorMessage: message, updatedAt: new Date() })
    .where(and(eq(recallBuildState.buildId, job.buildId), eq(recallBuildState.assetId, job.assetId),
      eq(recallBuildState.desiredRevision, job.sourceRevision),
      or(isNull(recallBuildState.indexedRevision), lt(recallBuildState.indexedRevision, job.sourceRevision))));
}
