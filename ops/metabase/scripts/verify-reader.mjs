import fs from "node:fs";
import mysql from "mysql2/promise";

const expectedTables = [
  "users",
  "tasks",
  "task_items",
  "idempotency_requests",
  "media_objects",
  "video_sources",
  "task_item_segments",
  "assets",
  "analysis_results",
  "tags",
  "asset_tags",
  "asset_tag_rejections",
  "jobs",
  "outbox_events",
  "callback_deliveries",
  "search_index_state",
];

const expectedViews = [
  "reporting_database_tables",
  "reporting_user_assets",
];

function sslOptions() {
  const caPath = process.env.DATABASE_SSL_CA_PATH?.trim();
  if (!caPath) return undefined;
  return {
    ca: fs.readFileSync(caPath, "utf8"),
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
  };
}

async function verify(environment) {
  const prefix = `METABASE_${environment}_DB_`;
  const values = Object.fromEntries(
    ["HOST", "PORT", "NAME", "USER", "PASS"].map((suffix) => [
      suffix,
      process.env[`${prefix}${suffix}`]?.trim(),
    ]),
  );
  for (const [suffix, value] of Object.entries(values)) {
    if (!value) throw new Error(`缺少环境变量 ${prefix}${suffix}`);
  }

  const connection = await mysql.createConnection({
    host: values.HOST,
    port: Number(values.PORT),
    user: values.USER,
    password: values.PASS,
    database: values.NAME,
    ssl: sslOptions(),
    multipleStatements: false,
  });

  try {
    const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER");
    const grants = grantRows.map((row) => String(Object.values(row)[0]));
    const unsafeGrant = grants.find((grant) => {
      if (grant.startsWith("GRANT USAGE ")) return false;
      return !/^GRANT SELECT ON /.test(grant);
    });
    if (unsafeGrant) throw new Error(`${environment} 账号包含非只读授权：${unsafeGrant}`);

    const [tableRows] = await connection.query(
      "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
      [values.NAME],
    );
    const visibleTables = new Set(
      tableRows
        .filter((row) => row.TABLE_TYPE === "BASE TABLE")
        .map((row) => row.TABLE_NAME),
    );
    const visibleViews = new Set(
      tableRows
        .filter((row) => row.TABLE_TYPE === "VIEW")
        .map((row) => row.TABLE_NAME),
    );
    const missingTables = expectedTables.filter(
      (table) => !visibleTables.has(table),
    );
    const missingViews = expectedViews.filter((view) => !visibleViews.has(view));
    if (missingTables.length || missingViews.length) {
      throw new Error(
        `${environment} 缺少可见对象：${[
          ...missingTables,
          ...missingViews,
        ].join(", ")}`,
      );
    }

    const [columnRows] = await connection.query(
      "SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?",
      [values.NAME],
    );
    console.log(
      `${environment}: 只读授权有效，${expectedTables.length} 张应用表和 ${expectedViews.length} 个报表视图全部可见，共 ${columnRows[0].total} 个可查询字段。`,
    );
  } finally {
    await connection.end();
  }
}

await verify("PRD");
