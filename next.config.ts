import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright 的 next dev 使用独立目录，避免覆盖可供 start.sh 直接运行的
  // 生产 .next 构建产物。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
