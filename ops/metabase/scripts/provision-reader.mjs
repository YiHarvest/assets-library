import fs from "node:fs";
import mysql from "mysql2/promise";

const required = [
  "METABASE_MYSQL_ADMIN_URL",
  "METABASE_MYSQL_ALLOWED_HOST",
  "METABASE_PRD_DB_NAME",
  "METABASE_PRD_DB_USER",
  "METABASE_PRD_DB_PASS",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    console.error(`缺少环境变量 ${name}。`);
    process.exit(1);
  }
}

const allowedHost = process.env.METABASE_MYSQL_ALLOWED_HOST.trim();
if (allowedHost === "%") {
  console.error("METABASE_MYSQL_ALLOWED_HOST 不允许使用通配符 %。");
  process.exit(1);
}

const adminUrl = new URL(process.env.METABASE_MYSQL_ADMIN_URL);
if (adminUrl.protocol !== "mysql:") {
  console.error("METABASE_MYSQL_ADMIN_URL 必须使用 mysql:// 协议。");
  process.exit(1);
}

function sslOptions() {
  const caPath = process.env.DATABASE_SSL_CA_PATH?.trim();
  if (!caPath) return undefined;
  return {
    ca: fs.readFileSync(caPath, "utf8"),
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
  };
}

function accountSql(connection, username) {
  return `${connection.escape(username)}@${connection.escape(allowedHost)}`;
}

async function preflightReader(connection, { database, username }) {
  const [databaseRows] = await connection.query(
    "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
    [database],
  );
  if (databaseRows.length === 0) throw new Error(`数据库不存在：${database}`);

  const [userRows] = await connection.query(
    "SELECT 1 FROM mysql.user WHERE User = ? AND Host = ? LIMIT 1",
    [username, allowedHost],
  );
  if (userRows.length > 0) {
    throw new Error(
      `账号 ${username}@${allowedHost} 已存在；为避免意外轮换密码，脚本已停止。`,
    );
  }
}

async function provisionReader(connection, { database, username, password }) {
  const account = accountSql(connection, username);
  await connection.query(
    `CREATE USER ${account} IDENTIFIED BY ${connection.escape(password)} REQUIRE SSL WITH MAX_USER_CONNECTIONS 5`,
  );
  await connection.query(
    `GRANT SELECT ON ${connection.escapeId(database)}.* TO ${account}`,
  );
  console.log(`已创建只读账号 ${username}@${allowedHost}，目标库 ${database}。`);
}

const connection = await mysql.createConnection({
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 3306),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
  database: decodeURIComponent(adminUrl.pathname.replace(/^\//, "")) || "mysql",
  ssl: sslOptions(),
  multipleStatements: false,
});

const readers = [
  {
    database: process.env.METABASE_PRD_DB_NAME,
    username: process.env.METABASE_PRD_DB_USER,
    password: process.env.METABASE_PRD_DB_PASS,
  },
];

const createdAccounts = [];
try {
  for (const reader of readers) await preflightReader(connection, reader);
  for (const reader of readers) {
    await provisionReader(connection, reader);
    createdAccounts.push(reader.username);
  }
} catch (error) {
  for (const username of createdAccounts.reverse()) {
    await connection.query(`DROP USER ${accountSql(connection, username)}`);
  }
  throw error;
} finally {
  await connection.end();
}
