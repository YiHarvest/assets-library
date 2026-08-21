import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 两个 MySQL 集成套件共享受保护的 *_test 数据库；文件级串行可避免
    // 各套件的 TRUNCATE 生命周期互相污染，同时单个套件内部仍可测试并发。
    fileParallelism: false,
    coverage: { reporter: ["text", "html"] },
    env: {
      PRD_INTERNAL_SERVICE_HOST:
        process.env.TEST_PRD_INTERNAL_SERVICE_HOST ?? "your.com",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "mysql://root@localhost/assets_library_dev_test",
      SCENE_DETECT_BASE_URL:
        process.env.TEST_SCENE_DETECT_BASE_URL ?? "https://your.com",
      CHROMA_URL: process.env.TEST_CHROMA_URL ?? "https://your.com",
      API_INTERNAL_ORIGIN: "https://your.com",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
