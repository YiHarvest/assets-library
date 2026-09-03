import type { Pool } from "mysql2/promise";

export const integrationApplicationTables = [
  "analysis_results",
  "asset_tag_rejections",
  "asset_tags",
  "callback_deliveries",
  "idempotency_requests",
  "jobs",
  "media_objects",
  "outbox_events",
  "private_assets",
  "public_assets",
  "search_index_state",
  "tags",
  "task_item_segments",
  "task_items",
  "tasks",
  "users",
  "video_sources",
] as const;

type DatabaseEnvironment = Record<string, string | undefined>;

export function configuredWebUiDatabaseName(
  env: DatabaseEnvironment = process.env,
) {
  return env.APP_MODE?.trim() === "prd"
    ? env.PRD_DATABASE_NAME?.trim() || "assets_library"
    : env.DEV_DATABASE_NAME?.trim() || "assets_library_dev_test";
}

function databaseIdentity(value: string) {
  const url = new URL(value);
  if (url.protocol !== "mysql:") {
    throw new Error("TEST_DATABASE_URL 必须使用 mysql:// 协议。");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) {
    throw new Error("TEST_DATABASE_URL 必须包含主机和数据库名。");
  }
  return {
    hostname: url.hostname.toLowerCase(),
    port: url.port || "3306",
    database,
  };
}

function sameDatabase(
  left: ReturnType<typeof databaseIdentity>,
  right: ReturnType<typeof databaseIdentity>,
) {
  return left.hostname === right.hostname &&
    left.port === right.port &&
    left.database === right.database;
}

/**
 * 集成测试会执行 TRUNCATE，不能仅凭 `_test` 后缀判断安全；还必须把解析后的
 * WebUI 数据库名纳入比较，让误配在建立连接前直接失败。
 */
export function assertDedicatedIntegrationDatabase(
  testDatabaseUrl: string,
  application: {
    databaseUrl?: string;
    databaseName?: string;
  } = {},
) {
  const testTarget = databaseIdentity(testDatabaseUrl);
  if (!testTarget.database.endsWith("_test")) {
    throw new Error(
      "TEST_DATABASE_URL 必须指向以 _test 结尾的独立测试库。",
    );
  }
  if (
    application.databaseName === testTarget.database ||
    (application.databaseUrl &&
      sameDatabase(testTarget, databaseIdentity(application.databaseUrl)))
  ) {
    throw new Error("TEST_DATABASE_URL 不得与 WebUI 的 DATABASE_URL 指向同一数据库。");
  }
  return testTarget;
}

/**
 * `loadConfig` 会按 APP_MODE 再次覆写连接串中的库名，所以测试不能只修改
 * DATABASE_URL；必须在任何数据库单例导入前同步当前模式的库名配置。
 */
export function bindIntegrationDatabaseEnvironment(
  testDatabaseUrl: string,
  env: DatabaseEnvironment = process.env,
) {
  const appMode = env.APP_MODE?.trim() === "prd" ? "prd" : "dev";
  const testTarget = assertDedicatedIntegrationDatabase(testDatabaseUrl, {
    databaseName: configuredWebUiDatabaseName(env),
  });

  env.DATABASE_URL = testDatabaseUrl;
  if (appMode === "prd") {
    env.PRD_DATABASE_NAME = testTarget.database;
    env.PRD_INTERNAL_SERVICE_HOST = testTarget.hostname;
  } else {
    env.DEV_DATABASE_NAME = testTarget.database;
  }
  return testTarget;
}

/** 只清空已通过专用目标校验的业务表，不删除数据库或 migration 账本。 */
export async function truncateIntegrationTables(pool: Pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of integrationApplicationTables) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    try {
      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    } finally {
      connection.release();
    }
  }
}
