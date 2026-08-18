import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright 的 next dev 使用独立目录，避免覆盖可供 start.sh 直接运行的
  // 生产 .next 构建产物。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  basePath: undefined,
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  async rewrites() {
    const prefix = process.env.NEXT_PUBLIC_BASE_PATH;
    if (!prefix) return [];
    return [
      { source: `${prefix}/:path*`, destination: "/:path*" },
      { source: `${prefix}`, destination: "/" },
    ];
  },
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
