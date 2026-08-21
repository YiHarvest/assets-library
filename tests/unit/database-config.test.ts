import { describe, expect, it } from "vitest";
import { loadTestConfig as loadConfig } from "../helpers/config";

// 脱敏：测试文件不写死真实内网地址，统一从 env 读取。
// 需要连真实测试库/模型网关时在环境里设置 TEST_* 变量；缺省回退到占位主机，
// 与 .env.example 的占位约定（dev-services.example.com / change-me）保持一致。
const productionDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "mysql://assets_library_app:change-me@your.com/assets_library";
const vlmBaseUrl = (
  process.env.TEST_VLM_BASE_URL ??
  "https://your.com/v1"
).replace(/\/$/, "");
const embeddingBaseUrl = (
  process.env.TEST_EMBEDDING_BASE_URL ??
  "https://your.com/v1"
).replace(/\/$/, "");
const webUiLockKey = "test-only-webui-lock-key-32-bytes-minimum";

// 与 loadConfig 内部一致地替换 URL 的数据库名/主机名，断言随 env 取值自适应。
function withDatabaseName(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withHostname(url: string, hostname: string) {
  const parsed = new URL(url);
  parsed.hostname = hostname;
  return parsed.toString().replace(/\/$/, "");
}

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
      WEBUI_LOCK_KEY: webUiLockKey,
      PRD_INTERNAL_SERVICE_HOST: "your.com",
      DATABASE_URL: productionDatabaseUrl,
      DEV_DATABASE_NAME: "assets_library_test",
      PRD_DATABASE_NAME: "assets_library",
      VLM_BASE_URL: vlmBaseUrl,
      VLM_NAME: "vision-model",
      EMBEDDING_BASE_URL: embeddingBaseUrl,
      EMBEDDING_MODEL: "embedding-model",
    });

    expect(config.databaseUrl).toBe(
      withHostname(
        withDatabaseName(productionDatabaseUrl, "assets_library"),
        "your.com",
      ),
    );
    expect(config.models.vlm.baseUrl).toBe(
      withHostname(vlmBaseUrl, "your.com"),
    );
    expect(config.embeddingBaseUrl).toBe(
      withHostname(embeddingBaseUrl, "your.com"),
    );
  });

  it("uses the development database in dev mode", () => {
    const config = loadConfig({
      APP_MODE: "dev",
      PRD_INTERNAL_SERVICE_HOST: "your.com",
      DATABASE_URL: productionDatabaseUrl,
      DEV_DATABASE_NAME: "assets_library_test",
      VLM_BASE_URL: vlmBaseUrl,
      VLM_NAME: "vision-model",
      EMBEDDING_BASE_URL: embeddingBaseUrl,
      EMBEDDING_MODEL: "embedding-model",
    });

    expect(config.databaseUrl).toBe(
      withDatabaseName(productionDatabaseUrl, "assets_library_test"),
    );
    expect(config.models.vlm.baseUrl).toBe(vlmBaseUrl);
    expect(config.embeddingBaseUrl).toBe(embeddingBaseUrl);
  });

  it("rejects wildcard listen addresses as production connection targets", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "prd",
        WEBUI_LOCK_KEY: webUiLockKey,
        PRD_INTERNAL_SERVICE_HOST: Array.from({ length: 4 }, () => "0").join("."),
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

  it("rejects a test database name in production mode", () => {
    expect(() =>
      loadConfig({
        APP_MODE: "prd",
        WEBUI_LOCK_KEY: webUiLockKey,
        DATABASE_URL: productionDatabaseUrl,
        PRD_DATABASE_NAME: "assets_library_test",
      }),
    ).toThrow(/生产模式数据库名|_test/);
  });
});
