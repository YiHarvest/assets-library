import { defineConfig } from "@playwright/test";

try {
  // Node 读取 env 文件时默认不覆盖既有变量；这里的测试配置应始终以
  // 项目 .env 中的专用 `_test` 数据库为准，避免 shell 中的空变量遮蔽它。
  process.loadEnvFile?.(".env");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured for Playwright.`);
  return value;
}

const databaseUrl = requiredEnv("TEST_DATABASE_URL");
const e2ePort = requiredEnv("E2E_PORT");
const e2eBaseUrl = requiredEnv("E2E_BASE_URL");
const e2eServerUrl = requiredEnv("E2E_SERVER_URL");
const databaseName = decodeURIComponent(
  new URL(databaseUrl).pathname.replace(/^\//, ""),
);
if (!databaseName.endsWith("_test")) {
  throw new Error("Playwright 只能连接以 _test 结尾的独立测试库。");
}

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: e2eBaseUrl },
  webServer: {
    command: "./scripts/run-e2e-web.sh",
    // 在 Linux 上 localhost 可能优先解析到 ::1，而 Next 的测试进程只监听
    // IPv4；固定回环地址也让健康检查与浏览器访问使用同一端点。
    url: e2eServerUrl,
    env: {
      DATABASE_URL: databaseUrl,
      E2E_PORT: e2ePort,
      API_INTERNAL_ORIGIN: e2eServerUrl,
      DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH ?? "",
      MEDIA_ROOT: "/tmp/assets-library-e2e/media",
      // MCP e2e：默认 user_id + 允许切换的白名单（x-request-userid 用例）。
      MCP_DEFAULT_USER_ID:
        process.env.MCP_DEFAULT_USER_ID ?? "user_mcp_e2e_default",
      MCP_ALLOWED_USER_IDS:
        process.env.MCP_ALLOWED_USER_IDS ?? "user_clip,user_editor",
      // 任意用户模式测试：允许 x-request-userid 传任意值。
      MCP_ALLOW_ANY_USER_ID: "true",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
