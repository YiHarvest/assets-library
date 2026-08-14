import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: MySql2Database<typeof schema>;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required.");
    const poolSize = Number(process.env.DATABASE_POOL_SIZE ?? 20);
    if (!Number.isSafeInteger(poolSize) || poolSize < 1 || poolSize > 100) {
      throw new Error("DATABASE_POOL_SIZE must be an integer between 1 and 100.");
    }
    const sslCaPath = process.env.DATABASE_SSL_CA_PATH?.trim();
    const resolvedSslCaPath = sslCaPath
      ? path.resolve(process.env.PROJECT_ROOT ?? process.cwd(), sslCaPath)
      : undefined;
    this.pool = createPool({
      uri: databaseUrl,
      connectionLimit: poolSize,
      timezone: "Z",
      ...(resolvedSslCaPath
        ? { ssl: { ca: readFileSync(resolvedSslCaPath, "utf8"), rejectUnauthorized: true } }
        : {}),
    });
    this.db = drizzle(this.pool, { schema, mode: "default" });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
