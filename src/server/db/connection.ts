import fs from "node:fs";
import { drizzle } from "drizzle-orm/mysql2";
import {
  createPool,
  type Pool,
  type PoolOptions,
  type RowDataPacket,
} from "mysql2/promise";
import * as schema from "./schema";

export interface DatabaseOptions {
  url: string;
  sslCaPath?: string;
  poolSize?: number;
}

function isLoopback(hostname: string) {
  return /^(?:127(?:\.\d{1,3}){3}|localhost|::1)$/i.test(hostname);
}

function connectionOptions(options: DatabaseOptions): PoolOptions {
  const url = new URL(options.url);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL 必须使用 mysql:// 协议。");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error("DATABASE_URL 必须包含主机、用户名和数据库名。");
  }
  if (!options.sslCaPath && !isLoopback(url.hostname)) {
    throw new Error("远程 MySQL 连接必须配置 DATABASE_SSL_CA_PATH。");
  }

  const ssl = options.sslCaPath
    ? {
        ca: fs.readFileSync(options.sslCaPath, "utf8"),
        rejectUnauthorized: true,
        // 部署使用自签 CA，并已确认采用 VERIFY_CA 而不是 VERIFY_IDENTITY。
        // 这里仍校验证书链，只跳过主机名匹配。
        checkServerIdentity: () => undefined,
      }
    : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl,
    connectionLimit: options.poolSize ?? 20,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10_000,
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
  };
}

/** 创建 MySQL 连接池；真正的网络连接会在第一次查询时按需建立。 */
export function openDatabase(options: DatabaseOptions) {
  const pool = createPool(connectionOptions(options));
  const db = drizzle(pool, { schema, mode: "default" });
  return { pool, db };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;

/** 关闭测试或进程级连接池。生产单例通常由 Node 进程退出时回收。 */
export async function closeDatabase(connection: DatabaseConnection) {
  await connection.pool.end();
}

/**
 * 检查连接、会话 UTC 与 TLS。返回值不包含连接串或口令，可安全写入启动日志。
 */
export async function inspectDatabaseConnection(pool: Pool) {
  const [rows] = await pool.query<
    Array<
      RowDataPacket & {
        version: string;
        sessionTimeZone: string;
        utcNow: Date;
        sslCipher: string | null;
      }
    >
  >(
    `SELECT VERSION() AS version,
            @@session.time_zone AS sessionTimeZone,
            UTC_TIMESTAMP(3) AS utcNow,
            (SELECT VARIABLE_VALUE FROM performance_schema.session_status
             WHERE VARIABLE_NAME = 'Ssl_cipher') AS sslCipher`,
  );
  const result = rows[0];
  if (!result) throw new Error("MySQL 连接检查没有返回结果。");
  return result;
}
