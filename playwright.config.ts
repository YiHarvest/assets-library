import { defineConfig } from "@playwright/test";

try {
  // Node 读取 env 文件时默认不覆盖既有变量；这里的测试配置应始终以
  // 项目 .env 中的专用 `_test` 数据库为准，避免 shell 中的空变量遮蔽它。
  process.loadEnvFile?.(".env");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

const databaseUrl =
  process.env.TEST_DATABASE_URL?.trim() ||
  "mysql://assets_library_app:change-me@127.0.0.1:3306/assets_library_test";
const databaseName = decodeURIComponent(
  new URL(databaseUrl).pathname.replace(/^\//, ""),
);
if (!databaseName.endsWith("_test")) {
  throw new Error("Playwright 只能连接以 _test 结尾的独立测试库。");
}

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command:
      "pnpm db:migrate && NEXT_DIST_DIR=.next-e2e pnpm exec next dev -p 3100",
    // 在 Linux 上 localhost 可能优先解析到 ::1，而 Next 的测试进程只监听
    // IPv4；固定回环地址也让健康检查与浏览器访问使用同一端点。
    url: "http://127.0.0.1:3100/",
    env: {
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH ?? "",
      MEDIA_ROOT: "/tmp/assets-library-e2e/media",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
