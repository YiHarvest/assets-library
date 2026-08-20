import path from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import {
  analysisResults,
  assets,
  assetTagRejections,
  assetTags,
  callbackDeliveries,
  idempotencyRequests,
  jobs,
  mediaObjects,
  outboxEvents,
  searchIndexState,
  tags,
  taskItemSegments,
  taskItems,
  tasks,
  users,
  videoSources,
} from "@/server/db/schema";
import {
  closeDatabase,
  inspectDatabaseConnection,
  openDatabase,
  type DatabaseConnection,
  type DatabaseOptions,
} from "@/server/db/connection";

export const defaultMigrationsFolder = path.resolve(process.cwd(), "drizzle");

const applicationTables = [
  users,
  tasks,
  taskItems,
  idempotencyRequests,
  mediaObjects,
  videoSources,
  taskItemSegments,
  assets,
  analysisResults,
  tags,
  assetTags,
  assetTagRejections,
  jobs,
  outboxEvents,
  callbackDeliveries,
  searchIndexState,
] as const;

export const expectedDatabaseColumns = applicationTables.flatMap((table) =>
  Object.values(getTableColumns(table)).map(
    (column) => `${getTableName(table)}.${column.name}`,
  ),
);

export function missingDatabaseColumns(
  actual: ReadonlyArray<{ TABLE_NAME: string; COLUMN_NAME: string }>,
) {
  const present = new Set(
    actual.map((column) => `${column.TABLE_NAME}.${column.COLUMN_NAME}`),
  );
  return expectedDatabaseColumns.filter((column) => !present.has(column));
}

/** 防止迁移账本与实际 schema 漂移时误报“up to date”。 */
export async function assertDatabaseSchema(connection: DatabaseConnection) {
  const [rows] = await connection.pool.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );
  const missing = missingDatabaseColumns(
    rows as Array<{ TABLE_NAME: string; COLUMN_NAME: string }>,
  );
  if (missing.length > 0) {
    const sample = missing.slice(0, 20).join(", ");
    const remainder = missing.length > 20 ? ` 等 ${missing.length} 项` : "";
    throw new Error(
      `数据库迁移账本与实际表结构不一致，缺少：${sample}${remainder}。请勿继续启动 Web/worker。`,
    );
  }
}

/** MySQL 迁移必须显式 await，避免 Web/worker 在 DDL 尚未完成时启动。 */
export async function migrateDatabase(
  connection: DatabaseConnection,
  migrationsFolder = defaultMigrationsFolder,
) {
  await migrate(connection.db, { migrationsFolder });
}

export async function initializeDatabase(
  options: DatabaseOptions,
  migrationsFolder = defaultMigrationsFolder,
) {
  const connection = openDatabase(options);
  try {
    await inspectDatabaseConnection(connection.pool);
    await migrateDatabase(connection, migrationsFolder);
    await assertDatabaseSchema(connection);
    return connection;
  } catch (error) {
    await closeDatabase(connection);
    throw error;
  }
}
