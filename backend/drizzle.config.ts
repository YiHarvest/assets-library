import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // generate 不访问数据库；migrate 由 src/database/migrate.ts 严格校验环境变量。
    url: process.env.DATABASE_URL ?? "mysql://invalid:invalid@127.0.0.1:3306/invalid",
  },
  strict: true,
  verbose: true,
});
