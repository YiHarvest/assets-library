import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";

const productionDatabaseUrl =
  "mysql://assets_library_app:password@183.147.142.111:20014/assets_library";

describe("database configuration", () => {
  it("defaults to four workers and a per-task analyze soft limit of two", () => {
    const config = loadConfig({
      APP_MODE: "dev",
      DATABASE_URL: productionDatabaseUrl,
      DEV_DATABASE_NAME: "assets_library_test",
    });

    expect(config.WORKER_CONCURRENCY).toBe(4);
    expect(config.WORKER_ANALYZE_TASK_SOFT_LIMIT).toBe(2);
    expect(config.DATABASE_POOL_SIZE).toBe(6);
  });

  it("rejects a per-task analyze limit above global concurrency", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "dev",
        DATABASE_URL: productionDatabaseUrl,
        DEV_DATABASE_NAME: "assets_library_test",
        WORKER_CONCURRENCY: "4",
        WORKER_ANALYZE_TASK_SOFT_LIMIT: "5",
      }),
    ).toThrow(/软上限|worker/);
  });

  it("uses the formal database in production mode", () => {
    const config = loadConfig({
      APP_MODE: "prd",
      PRD_INTERNAL_SERVICE_HOST: "127.0.0.1",
      DATABASE_URL: productionDatabaseUrl,
      DEV_DATABASE_NAME: "assets_library_test",
      VLM_BASE_URL: "http://183.147.142.111:30000/v1",
      VLM_NAME: "vision-model",
      EMBEDDING_BASE_URL: "http://183.147.142.111:39999/v1",
      EMBEDDING_MODEL: "embedding-model",
    });

    expect(config.databaseUrl).toBe(
      "mysql://assets_library_app:password@127.0.0.1:20014/assets_library",
    );
    expect(config.models.vlm.baseUrl).toBe("http://127.0.0.1:30000/v1");
    expect(config.embeddingBaseUrl).toBe("http://127.0.0.1:39999/v1");
  });

  it("uses the development database in dev mode", () => {
    const config = loadConfig({
      APP_MODE: "dev",
      PRD_INTERNAL_SERVICE_HOST: "127.0.0.1",
      DATABASE_URL: productionDatabaseUrl,
      DEV_DATABASE_NAME: "assets_library_test",
      VLM_BASE_URL: "http://183.147.142.111:30000/v1",
      VLM_NAME: "vision-model",
      EMBEDDING_BASE_URL: "http://183.147.142.111:39999/v1",
      EMBEDDING_MODEL: "embedding-model",
    });

    expect(config.databaseUrl).toBe(
      "mysql://assets_library_app:password@183.147.142.111:20014/assets_library_test",
    );
    expect(config.models.vlm.baseUrl).toBe("http://183.147.142.111:30000/v1");
    expect(config.embeddingBaseUrl).toBe("http://183.147.142.111:39999/v1");
  });

  it("rejects wildcard listen addresses as production connection targets", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "prd",
        PRD_INTERNAL_SERVICE_HOST: "0.0.0.0",
        DATABASE_URL: productionDatabaseUrl,
      }),
    ).toThrow(/通配监听地址/);
  });

  it("rejects a non-test database in dev mode", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "dev",
        DATABASE_URL: productionDatabaseUrl,
        DEV_DATABASE_NAME: "assets_library",
      }),
    ).toThrow(/_test|测试数据库/);
  });

  it("rejects a test database in production mode", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "prd",
        DATABASE_URL:
          "mysql://assets_library_app:password@183.147.142.111:20014/assets_library_test",
      }),
    ).toThrow(/生产模式拒绝连接测试数据库/);
  });
});
