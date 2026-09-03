import { loadConfig } from "@/server/config";
import { createZosObjectStorage } from "@/server/storage/zos";
import { closeDatabase } from "./connection";
import { migrateLegacyAssets } from "./legacy-asset-migration";
import { initializeDatabase } from "./migrations";

async function main() {
  const config = loadConfig();
  const connection = await initializeDatabase({
    url: config.databaseUrl,
    sslCaPath: config.databaseSslCaPath,
    poolSize: config.DATABASE_POOL_SIZE,
  });
  try {
    const legacy = await migrateLegacyAssets(
      connection,
      () => createZosObjectStorage(config),
    );
    console.log(
      legacy.status === "skipped"
        ? "Legacy asset migration is already complete."
        : `Migrated ${legacy.legacyAssetCount} legacy assets and copied ${legacy.copiedObjectCount} ZOS objects.`,
    );
    console.log("MySQL database schema is up to date.");
  } finally {
    await closeDatabase(connection);
  }
}

void main().catch((error: unknown) => {
  console.error("MySQL database migration failed.", error);
  process.exitCode = 1;
});
