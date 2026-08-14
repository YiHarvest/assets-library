import "reflect-metadata";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "node:path";
import { DatabaseService } from "./database.service";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database migration.");
  const database = new DatabaseService();
  const lockConnection = await database.pool.getConnection();
  try {
    const [rows] = await lockConnection.query("SELECT GET_LOCK('assets_library_migration', 60) AS acquired");
    const acquired = Number((rows as Array<{ acquired?: number }>)[0]?.acquired ?? 0);
    if (acquired !== 1) throw new Error("Could not acquire the database migration lock within 60 seconds.");
    await migrate(database.db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  } finally {
    await lockConnection.query("SELECT RELEASE_LOCK('assets_library_migration')").catch(() => undefined);
    lockConnection.release();
    await database.onModuleDestroy();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
