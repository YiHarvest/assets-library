import { defineConfig } from "drizzle-kit";
import { loadConfig } from "./src/server/config";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

const config = loadConfig();

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: config.databaseUrl,
  },
});
