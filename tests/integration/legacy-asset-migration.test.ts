import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { closeDatabase, type DatabaseConnection } from "@/server/db/connection";
import { migrateLegacyAssets } from "@/server/db/legacy-asset-migration";
import { initializeDatabase } from "@/server/db/migrations";
import {
  analysisResults,
  jobs,
  legacyAssets,
  mediaObjects,
  privateAssets,
  publicAssets,
  searchIndexState,
  tags,
} from "@/server/db/schema";
import type { ObjectStorage } from "@/server/storage/object-storage";
import {
  bindIntegrationDatabaseEnvironment,
  integrationApplicationTables,
} from "../helpers/integration-database";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mysqlTest = testDatabaseUrl ? describe : describe.skip;

mysqlTest("legacy asset startup migration", () => {
  let connection: DatabaseConnection;
  let legacyLinksAvailable = false;

  async function resetTables() {
    const raw = await connection.pool.getConnection();
    try {
      await raw.query("SET FOREIGN_KEY_CHECKS = 0");
      for (const table of [...integrationApplicationTables, "assets"]) {
        await raw.query(`TRUNCATE TABLE \`${table}\``);
      }
      await raw
        .query("DELETE FROM legacy_asset_migration_state")
        .catch((error: NodeJS.ErrnoException & { code?: string }) => {
          if (error.code !== "ER_NO_SUCH_TABLE") throw error;
        });
    } finally {
      await raw.query("SET FOREIGN_KEY_CHECKS = 1");
      raw.release();
    }
  }

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    bindIntegrationDatabaseEnvironment(testDatabaseUrl);
    connection = await initializeDatabase({
      url: testDatabaseUrl,
      sslCaPath: process.env.DATABASE_SSL_CA_PATH || undefined,
      poolSize: 4,
    });
    const [columns] = await connection.pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'analysis_results' AND COLUMN_NAME = 'asset_id'`,
    );
    legacyLinksAvailable = Number(columns[0]?.count ?? 0) === 1;
  }, 30_000);

  beforeEach(async () => {
    if (connection) await resetTables();
  });

  afterEach(async () => {
    if (connection) await resetTables();
  });

  afterAll(async () => {
    if (connection) await closeDatabase(connection);
  });

  test("copies public/private rows, media and related records exactly once", async () => {
    // 已运行过旧版破坏性 0007 的共享测试库无法恢复旧关联列；全新库会执行完整断言。
    if (!legacyLinksAvailable) return;

    const now = new Date("2026-09-04T00:00:00.000Z");
    const publicAssetId = crypto.randomUUID();
    const privateAssetId = crypto.randomUUID();
    const publicMediaId = crypto.randomUUID();
    const privateMediaId = crypto.randomUUID();
    const tagId = crypto.randomUUID();
    await connection.db.insert(mediaObjects).values([
      {
        id: publicMediaId,
        provider: "zos",
        bucket: "assets",
        objectKey: "legacy/public.png",
        mimeType: "image/png",
        sizeBytes: 3,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: privateMediaId,
        provider: "zos",
        bucket: "assets",
        objectKey: "legacy/private.png",
        mimeType: "image/png",
        sizeBytes: 4,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await connection.db.insert(legacyAssets).values([
      {
        id: publicAssetId,
        userId: null,
        mediaObjectId: publicMediaId,
        name: "公共图片",
        description: "公共",
        mediaType: "image",
        originalFilename: "public.png",
        originalPath: "legacy/public.png",
        mimeType: "image/png",
        sizeBytes: 3,
        processingStatus: "completed",
        reviewStatus: "published",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: privateAssetId,
        userId: "user-1",
        mediaObjectId: privateMediaId,
        name: "用户图片",
        description: "用户",
        mediaType: "image",
        originalFilename: "private.png",
        originalPath: "legacy/private.png",
        mimeType: "image/png",
        sizeBytes: 4,
        processingStatus: "completed",
        reviewStatus: "pending_review",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await connection.db.insert(tags).values({
      id: tagId,
      category: "scene",
      value: "室内",
      normalizedValue: "室内",
      createdAt: now,
    });
    for (const assetId of [publicAssetId, privateAssetId]) {
      await connection.pool.execute(
        `INSERT INTO analysis_results
           (id, asset_id, public_asset_id, private_asset_id, schema_version,
            result_json, model_protocol, model_name, completed_at)
         VALUES (?, ?, NULL, NULL, 1, ?, 'openai_responses', 'test-model', ?)`,
        [crypto.randomUUID(), assetId, JSON.stringify({ kind: "image" }), now],
      );
      await connection.pool.execute(
        `INSERT INTO asset_tags
           (id, asset_id, public_asset_id, private_asset_id, tag_id, source, confidence)
         VALUES (?, ?, NULL, NULL, ?, 'model', 0.9)`,
        [crypto.randomUUID(), assetId, tagId],
      );
      await connection.pool.execute(
        `INSERT INTO asset_tag_rejections
           (id, asset_id, public_asset_id, private_asset_id, category, normalized_value)
         VALUES (?, ?, NULL, NULL, 'scene', '室外')`,
        [crypto.randomUUID(), assetId],
      );
      await connection.pool.execute(
        `INSERT INTO search_index_state
           (id, asset_id, public_asset_id, private_asset_id, status, updated_at)
         VALUES (?, ?, NULL, NULL, 'done', ?)`,
        [crypto.randomUUID(), assetId, now],
      );
    }

    const copyObject = vi.fn(async (input: { sourceKey: string; destinationKey: string }) => ({
      key: input.destinationKey,
      sizeBytes: 4,
      etag: "copied",
      url: `https://cdn.example.test/${input.destinationKey}`,
    }));
    const storage = { copyObject } as unknown as ObjectStorage;
    const first = await migrateLegacyAssets(connection, () => storage);
    expect(first).toMatchObject({
      status: "completed",
      legacyAssetCount: 2,
      copiedObjectCount: 1,
    });

    const migratedPublic = await connection.db.select().from(publicAssets);
    const migratedPrivate = await connection.db.select().from(privateAssets);
    expect(migratedPublic).toHaveLength(2);
    expect(migratedPrivate).toHaveLength(1);
    expect(migratedPrivate[0]).toMatchObject({
      id: privateAssetId,
      userId: "user-1",
      mediaObjectId: privateMediaId,
    });
    const pairedPublic = migratedPublic.find(
      (asset) => asset.id === migratedPrivate[0]!.publicAssetId,
    );
    expect(pairedPublic?.mediaObjectId).not.toBe(privateMediaId);
    expect(copyObject).toHaveBeenCalledOnce();

    expect(await connection.db.select().from(analysisResults)).toHaveLength(5);
    expect(await connection.db.select().from(searchIndexState)).toHaveLength(5);
    expect(
      (await connection.db.select().from(jobs)).filter(
        (job) => job.publicAssetId === pairedPublic?.id && job.type === "embed",
      ),
    ).toHaveLength(1);

    const second = await migrateLegacyAssets(connection, () => {
      throw new Error("completed migration must not initialize ZOS");
    });
    expect(second.status).toBe("skipped");
    expect(await connection.db.select().from(publicAssets)).toHaveLength(2);
  }, 30_000);
});
