import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
import {
  legacyAssets,
  mediaObjects,
  privateAssets,
  publicAssets,
  videoSources,
} from "./schema";
import type { DatabaseConnection } from "./connection";
import type { ObjectStorage } from "@/server/storage/object-storage";

const migrationName = "assets_to_public_private_v1";
const migrationLock = "assets_library:assets_to_public_private_v1";
const copiedObjectPrefix = "assets/migrated/public/";

type LegacyAsset = typeof legacyAssets.$inferSelect;

interface CountRow extends RowDataPacket {
  count: number | string;
}

interface LockRow extends RowDataPacket {
  acquired: number | string | null;
}

interface MigrationStateRow extends RowDataPacket {
  status: string;
}

interface LegacyVideoSourceRow extends RowDataPacket {
  id: string;
  mediaObjectId: string | null;
}

export interface LegacyAssetMigrationResult {
  status: "completed" | "skipped";
  legacyAssetCount: number;
  copiedObjectCount: number;
}

function assetValues(asset: LegacyAsset) {
  return {
    taskId: asset.taskId,
    taskItemId: asset.taskItemId,
    taskItemSegmentId: asset.taskItemSegmentId,
    videoSourceId: asset.videoSourceId,
    mediaObjectId: asset.mediaObjectId,
    thumbnailMediaObjectId: asset.thumbnailMediaObjectId,
    segmentIndex: asset.segmentIndex,
    segmentStartMs: asset.segmentStartMs,
    segmentEndMs: asset.segmentEndMs,
    name: asset.name,
    description: asset.description,
    mediaType: asset.mediaType,
    originalFilename: asset.originalFilename,
    originalPath: asset.originalPath,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    processingStatus: asset.processingStatus,
    failureCode: asset.failureCode,
    failureMessage: asset.failureMessage,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    deletedAt: asset.deletedAt,
  };
}

async function scalar(
  connection: DatabaseConnection,
  statement: string,
  values: Array<string | number | null> = [],
) {
  const [rows] = await connection.pool.execute<CountRow[]>(statement, values);
  return Number(rows[0]?.count ?? 0);
}

async function ensureMigrationStateTable(connection: DatabaseConnection) {
  await connection.pool.query(`
    CREATE TABLE IF NOT EXISTS legacy_asset_migration_state (
      name varchar(191) NOT NULL,
      status enum('running','completed','failed') NOT NULL,
      error_message text,
      started_at datetime(3) NOT NULL,
      completed_at datetime(3),
      updated_at datetime(3) NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB
  `);
}

async function migrationCompleted(connection: DatabaseConnection) {
  const [rows] = await connection.pool.execute<MigrationStateRow[]>(
    "SELECT status FROM legacy_asset_migration_state WHERE name = ? LIMIT 1",
    [migrationName],
  );
  return rows[0]?.status === "completed";
}

async function setMigrationRunning(connection: DatabaseConnection) {
  await connection.pool.execute(
    `INSERT INTO legacy_asset_migration_state
       (name, status, error_message, started_at, completed_at, updated_at)
     VALUES (?, 'running', NULL, CURRENT_TIMESTAMP(3), NULL, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       status = 'running', error_message = NULL, completed_at = NULL,
       updated_at = CURRENT_TIMESTAMP(3)`,
    [migrationName],
  );
}

async function setMigrationFailed(
  connection: DatabaseConnection,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  await connection.pool.execute(
    `UPDATE legacy_asset_migration_state
     SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE name = ?`,
    [message.slice(0, 65_535), migrationName],
  );
}

async function setMigrationCompleted(connection: DatabaseConnection) {
  await connection.pool.execute(
    `UPDATE legacy_asset_migration_state
     SET status = 'completed', error_message = NULL,
         completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE name = ?`,
    [migrationName],
  );
}

async function hasColumn(
  connection: DatabaseConnection,
  table: string,
  column: string,
) {
  return (
    (await scalar(
      connection,
      `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    )) === 1
  );
}

async function assertLegacyLinksAvailable(connection: DatabaseConnection) {
  const required = [
    ["analysis_results", "asset_id"],
    ["asset_tag_rejections", "asset_id"],
    ["asset_tags", "asset_id"],
    ["jobs", "asset_id"],
    ["search_index_state", "asset_id"],
    ["video_sources", "media_object_id"],
  ] as const;
  const missing: string[] = [];
  for (const [table, column] of required) {
    if (!(await hasColumn(connection, table, column))) {
      missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `旧素材关联列已被提前删除，无法完整迁移：${missing.join(", ")}。`,
    );
  }
  const activeJobs = await scalar(
    connection,
    `SELECT COUNT(*) AS count FROM jobs
     WHERE asset_id IS NOT NULL AND status IN ('queued', 'running')`,
  );
  if (activeJobs > 0) {
    throw new Error(`仍有 ${activeJobs} 个旧素材作业未结束，已停止数据迁移。`);
  }
}

export function migratedPublicObjectKey(sourceMediaObjectId: string) {
  return `${copiedObjectPrefix}${sourceMediaObjectId}`;
}

async function copyMediaObject(
  connection: DatabaseConnection,
  storage: ObjectStorage,
  sourceId: string,
  onCopied: () => void,
) {
  const [source] = await connection.db
    .select()
    .from(mediaObjects)
    .where(eq(mediaObjects.id, sourceId))
    .limit(1);
  if (!source) throw new Error(`旧媒体对象不存在：${sourceId}。`);
  if (source.provider !== "zos" || source.status !== "persisted") {
    throw new Error(`旧媒体对象 ${sourceId} 不是可复制的 ZOS 持久化对象。`);
  }

  const destinationKey = migratedPublicObjectKey(source.id);
  let [target] = await connection.db
    .select()
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.provider, "zos"),
        eq(mediaObjects.objectKey, destinationKey),
      ),
    )
    .limit(1);
  if (target?.status === "persisted") return target;

  const now = new Date();
  if (!target) {
    const id = crypto.randomUUID();
    await connection.db.insert(mediaObjects).values({
      id,
      provider: "zos",
      bucket: source.bucket,
      objectKey: destinationKey,
      publicUrl: null,
      localPath: null,
      sha256: source.sha256,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      status: "staging",
      createdAt: now,
      updatedAt: now,
    });
    [target] = await connection.db
      .select()
      .from(mediaObjects)
      .where(eq(mediaObjects.id, id))
      .limit(1);
  }
  if (!target) throw new Error(`迁移媒体对象无法创建：${sourceId}。`);

  const copied = await storage.copyObject({
    sourceKey: source.objectKey,
    destinationKey,
  });
  await connection.db
    .update(mediaObjects)
    .set({
      publicUrl: copied.url ?? null,
      sizeBytes: copied.sizeBytes,
      status: "persisted",
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(mediaObjects.id, target.id));
  onCopied();
  return { ...target, ...copied, objectKey: copied.key, status: "persisted" as const };
}

async function ensureAssetRows(
  connection: DatabaseConnection,
  asset: LegacyAsset,
) {
  const values = assetValues(asset);
  if (!asset.userId) {
    const [existing] = await connection.db
      .select({ id: publicAssets.id })
      .from(publicAssets)
      .where(eq(publicAssets.id, asset.id))
      .limit(1);
    if (!existing) {
      await connection.db.insert(publicAssets).values({
        id: asset.id,
        uploaderUserId: null,
        ...values,
        reviewStatus: asset.reviewStatus,
      });
    }
    return { publicAssetId: asset.id, privateAssetId: null };
  }

  const [existing] = await connection.db
    .select({ publicAssetId: privateAssets.publicAssetId })
    .from(privateAssets)
    .where(eq(privateAssets.id, asset.id))
    .limit(1);
  if (existing) {
    if (!existing.publicAssetId) {
      throw new Error(`私人素材 ${asset.id} 缺少配对公共素材 ID。`);
    }
    return { publicAssetId: existing.publicAssetId, privateAssetId: asset.id };
  }

  const publicAssetId = crypto.randomUUID();
  await connection.db.transaction(async (tx) => {
    await tx.insert(publicAssets).values({
      id: publicAssetId,
      uploaderUserId: asset.userId,
      ...values,
      mediaObjectId: null,
      thumbnailMediaObjectId: null,
      reviewStatus: asset.reviewStatus,
    });
    await tx.insert(privateAssets).values({
      id: asset.id,
      publicAssetId,
      userId: asset.userId!,
      ...values,
    });
  });
  return { publicAssetId, privateAssetId: asset.id };
}

async function cloneLegacyRelations(connection: DatabaseConnection) {
  await connection.pool.query(`
    INSERT IGNORE INTO analysis_results
      (id, public_asset_id, private_asset_id, schema_version, result_json,
       model_protocol, model_name, completed_at)
    SELECT UUID(), COALESCE(p.public_asset_id, a.id), NULL, old.schema_version,
           old.result_json, old.model_protocol, old.model_name, old.completed_at
    FROM analysis_results old
    INNER JOIN assets a ON a.id = old.asset_id
    LEFT JOIN private_assets p ON p.id = a.id
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO analysis_results
      (id, public_asset_id, private_asset_id, schema_version, result_json,
       model_protocol, model_name, completed_at)
    SELECT UUID(), NULL, a.id, old.schema_version, old.result_json,
           old.model_protocol, old.model_name, old.completed_at
    FROM analysis_results old
    INNER JOIN assets a ON a.id = old.asset_id AND a.user_id IS NOT NULL
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO asset_tags
      (id, public_asset_id, private_asset_id, tag_id, source, confidence)
    SELECT UUID(), COALESCE(p.public_asset_id, a.id), NULL,
           old.tag_id, old.source, old.confidence
    FROM asset_tags old
    INNER JOIN assets a ON a.id = old.asset_id
    LEFT JOIN private_assets p ON p.id = a.id
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO asset_tags
      (id, public_asset_id, private_asset_id, tag_id, source, confidence)
    SELECT UUID(), NULL, a.id, old.tag_id, old.source, old.confidence
    FROM asset_tags old
    INNER JOIN assets a ON a.id = old.asset_id AND a.user_id IS NOT NULL
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO asset_tag_rejections
      (id, public_asset_id, private_asset_id, category, normalized_value)
    SELECT UUID(), COALESCE(p.public_asset_id, a.id), NULL,
           old.category, old.normalized_value
    FROM asset_tag_rejections old
    INNER JOIN assets a ON a.id = old.asset_id
    LEFT JOIN private_assets p ON p.id = a.id
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO asset_tag_rejections
      (id, public_asset_id, private_asset_id, category, normalized_value)
    SELECT UUID(), NULL, a.id, old.category, old.normalized_value
    FROM asset_tag_rejections old
    INNER JOIN assets a ON a.id = old.asset_id AND a.user_id IS NOT NULL
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO search_index_state
      (id, public_asset_id, private_asset_id, status, content_hash,
       indexed_at, error_message, updated_at)
    SELECT UUID(), COALESCE(p.public_asset_id, a.id), NULL,
           CASE
             WHEN a.review_status = 'deleted' OR a.deleted_at IS NOT NULL THEN 'deleted'
             WHEN a.user_id IS NOT NULL THEN 'queued'
             ELSE old.status
           END,
           CASE WHEN a.user_id IS NULL THEN old.content_hash ELSE NULL END,
           CASE WHEN a.user_id IS NULL THEN old.indexed_at ELSE NULL END,
           CASE WHEN a.user_id IS NULL THEN old.error_message ELSE NULL END,
           old.updated_at
    FROM search_index_state old
    INNER JOIN assets a ON a.id = old.asset_id
    LEFT JOIN private_assets p ON p.id = a.id
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT IGNORE INTO search_index_state
      (id, public_asset_id, private_asset_id, status, content_hash,
       indexed_at, error_message, updated_at)
    SELECT UUID(), NULL, a.id, old.status, old.content_hash,
           old.indexed_at, old.error_message, old.updated_at
    FROM search_index_state old
    INNER JOIN assets a ON a.id = old.asset_id AND a.user_id IS NOT NULL
    WHERE old.asset_id IS NOT NULL
  `);
  await connection.pool.query(`
    INSERT INTO jobs
      (id, task_id, public_asset_id, private_asset_id, type, status, phase,
       attempt, available_at, created_at, updated_at)
    SELECT UUID(), a.task_id, p.public_asset_id, NULL, 'embed', 'queued',
           'analyzing', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
           CURRENT_TIMESTAMP(3)
    FROM assets a
    INNER JOIN private_assets p ON p.id = a.id
    INNER JOIN analysis_results analysis
      ON analysis.public_asset_id = p.public_asset_id
    WHERE a.user_id IS NOT NULL
      AND a.deleted_at IS NULL
      AND a.review_status <> 'deleted'
      AND NOT EXISTS (
        SELECT 1 FROM jobs existing
        WHERE existing.public_asset_id = p.public_asset_id
          AND existing.type = 'embed'
      )
  `);
}

async function migrateVideoSources(
  connection: DatabaseConnection,
  assets: LegacyAsset[],
  copiedMedia: (id: string) => Promise<{ id: string }>,
) {
  const scopes = new Map<string, boolean>();
  for (const asset of assets) {
    if (!asset.videoSourceId) continue;
    scopes.set(
      asset.videoSourceId,
      Boolean(asset.userId) || (scopes.get(asset.videoSourceId) ?? false),
    );
  }
  if (scopes.size === 0) return;

  const [rows] = await connection.pool.query<LegacyVideoSourceRow[]>(
    "SELECT id, media_object_id AS mediaObjectId FROM video_sources WHERE media_object_id IS NOT NULL",
  );
  for (const source of rows) {
    const hasPrivateAsset = scopes.get(source.id);
    if (hasPrivateAsset === undefined || !source.mediaObjectId) continue;
    if (!hasPrivateAsset) {
      await connection.db
        .update(videoSources)
        .set({ publicMediaObjectId: source.mediaObjectId })
        .where(eq(videoSources.id, source.id));
      continue;
    }
    const publicObject = await copiedMedia(source.mediaObjectId);
    await connection.db
      .update(videoSources)
      .set({
        publicMediaObjectId: publicObject.id,
        privateMediaObjectId: source.mediaObjectId,
      })
      .where(eq(videoSources.id, source.id));
  }
}

async function verifyMigration(connection: DatabaseConnection) {
  const checks: Array<[string, string]> = [
    [
      "缺少公共素材",
      `SELECT COUNT(*) AS count
       FROM assets a
       LEFT JOIN private_assets p ON p.id = a.id
       LEFT JOIN public_assets target
         ON target.id = CASE WHEN a.user_id IS NULL THEN a.id ELSE p.public_asset_id END
       WHERE target.id IS NULL`,
    ],
    [
      "缺少私人素材",
      `SELECT COUNT(*) AS count
       FROM assets a
       LEFT JOIN private_assets target ON target.id = a.id
       WHERE a.user_id IS NOT NULL AND target.id IS NULL`,
    ],
    [
      "公私素材仍引用同一媒体对象",
      `SELECT COUNT(*) AS count
       FROM assets a
       INNER JOIN private_assets priv ON priv.id = a.id
       INNER JOIN public_assets pub ON pub.id = priv.public_asset_id
       WHERE a.user_id IS NOT NULL AND (
         (a.media_object_id IS NOT NULL AND
           (pub.media_object_id IS NULL OR pub.media_object_id = priv.media_object_id))
         OR
         (a.thumbnail_media_object_id IS NOT NULL AND
           (pub.thumbnail_media_object_id IS NULL OR
            pub.thumbnail_media_object_id = priv.thumbnail_media_object_id))
       )`,
    ],
    [
      "父视频对象未完成公私拆分",
      `SELECT COUNT(*) AS count
       FROM video_sources source
       INNER JOIN (
         SELECT video_source_id, MAX(user_id IS NOT NULL) AS has_private
         FROM assets WHERE video_source_id IS NOT NULL GROUP BY video_source_id
       ) scope ON scope.video_source_id = source.id
       WHERE source.media_object_id IS NOT NULL AND (
         (scope.has_private = 1 AND (
           NOT (source.private_media_object_id <=> source.media_object_id)
           OR source.public_media_object_id IS NULL
           OR source.public_media_object_id = source.private_media_object_id
         ))
         OR
         (scope.has_private = 0 AND
           NOT (source.public_media_object_id <=> source.media_object_id))
       )`,
    ],
    [
      "迁移对象尚未持久化",
      `SELECT COUNT(*) AS count FROM media_objects
       WHERE object_key LIKE 'assets/migrated/public/%' AND status <> 'persisted'`,
    ],
  ];
  for (const [label, statement] of checks) {
    const count = await scalar(connection, statement);
    if (count > 0) throw new Error(`${label}：${count} 条。`);
  }

  for (const table of [
    "analysis_results",
    "asset_tags",
    "asset_tag_rejections",
    "search_index_state",
  ]) {
    const missingPublic = await scalar(
      connection,
      `SELECT COUNT(*) AS count
       FROM \`${table}\` old
       INNER JOIN assets a ON a.id = old.asset_id
       LEFT JOIN private_assets p ON p.id = a.id
       LEFT JOIN \`${table}\` target
         ON target.public_asset_id = COALESCE(p.public_asset_id, a.id)
       WHERE old.asset_id IS NOT NULL AND target.id IS NULL`,
    );
    const missingPrivate = await scalar(
      connection,
      `SELECT COUNT(*) AS count
       FROM \`${table}\` old
       INNER JOIN assets a ON a.id = old.asset_id AND a.user_id IS NOT NULL
       LEFT JOIN \`${table}\` target ON target.private_asset_id = a.id
       WHERE old.asset_id IS NOT NULL AND target.id IS NULL`,
    );
    if (missingPublic + missingPrivate > 0) {
      throw new Error(
        `${table} 迁移不完整：公共 ${missingPublic} 条，私人 ${missingPrivate} 条。`,
      );
    }
  }
}

/**
 * Web/worker 启动前执行的一次性迁移。目标行和目标 key 都稳定，进程中断后可重入；
 * 完成标记写入后不再触碰旧表，避免后续启动覆盖用户在新表中的修改。
 */
export async function migrateLegacyAssets(
  connection: DatabaseConnection,
  storageFactory: () => ObjectStorage,
): Promise<LegacyAssetMigrationResult> {
  await ensureMigrationStateTable(connection);
  const lockConnection = await connection.pool.getConnection();
  let acquired = false;
  try {
    const [lockRows] = await lockConnection.execute<LockRow[]>(
      "SELECT GET_LOCK(?, 60) AS acquired",
      [migrationLock],
    );
    acquired = Number(lockRows[0]?.acquired ?? 0) === 1;
    if (!acquired) throw new Error("等待旧素材迁移锁超时。");

    if (await migrationCompleted(connection)) {
      return { status: "skipped", legacyAssetCount: 0, copiedObjectCount: 0 };
    }
    const assets = await connection.db.select().from(legacyAssets);
    await setMigrationRunning(connection);
    if (assets.length === 0) {
      await setMigrationCompleted(connection);
      return { status: "completed", legacyAssetCount: 0, copiedObjectCount: 0 };
    }
    await assertLegacyLinksAvailable(connection);

    let storage: ObjectStorage | undefined;
    let copiedObjectCount = 0;
    const copies = new Map<string, Promise<Awaited<ReturnType<typeof copyMediaObject>>>>();
    const copiedMedia = (id: string) => {
      const existing = copies.get(id);
      if (existing) return existing;
      const operation = copyMediaObject(
        connection,
        (storage ??= storageFactory()),
        id,
        () => {
          copiedObjectCount += 1;
        },
      );
      copies.set(id, operation);
      return operation;
    };

    let nextIndex = 0;
    async function worker() {
      for (;;) {
        const asset = assets[nextIndex++];
        if (!asset) return;
        const target = await ensureAssetRows(connection, asset);
        if (!target.privateAssetId) continue;
        const publicMedia = asset.mediaObjectId
          ? await copiedMedia(asset.mediaObjectId)
          : null;
        const publicThumbnail = asset.thumbnailMediaObjectId
          ? await copiedMedia(asset.thumbnailMediaObjectId)
          : null;
        await connection.db
          .update(publicAssets)
          .set({
            mediaObjectId: publicMedia?.id ?? null,
            thumbnailMediaObjectId: publicThumbnail?.id ?? null,
            originalPath: publicMedia?.objectKey ?? asset.originalPath,
            updatedAt: asset.updatedAt,
          })
          .where(eq(publicAssets.id, target.publicAssetId));
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, assets.length) }, () => worker()),
    );
    await migrateVideoSources(connection, assets, copiedMedia);
    await cloneLegacyRelations(connection);
    await verifyMigration(connection);
    await setMigrationCompleted(connection);
    return {
      status: "completed",
      legacyAssetCount: assets.length,
      copiedObjectCount,
    };
  } catch (error) {
    if (acquired) await setMigrationFailed(connection, error).catch(() => undefined);
    throw error;
  } finally {
    if (acquired) {
      await lockConnection
        .execute("SELECT RELEASE_LOCK(?)", [migrationLock])
        .catch(() => undefined);
    }
    lockConnection.release();
  }
}
