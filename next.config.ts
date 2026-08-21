import type { NextConfig } from "next";

export function normalizePublicBasePath(value: string | undefined) {
  const segments = value?.trim().split("/").filter(Boolean) ?? [];
  return segments.length ? `/${segments.join("/")}` : "";
}

const publicBasePath = normalizePublicBasePath(
  process.env.NEXT_PUBLIC_BASE_PATH,
);

const nextConfig: NextConfig = {
  // Playwright 的 next dev 使用独立目录，避免覆盖可供 start.sh 直接运行的
  // 生产 .next 构建产物。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * 生产兼容性约束，禁止改成 Next.js `basePath`：
   *
   * 已部署域名和第三方调用方固定使用 `NEXT_PUBLIC_BASE_PATH/api/v1/**`。
   * 这里用 assetPrefix 生成带部署前缀的静态资源 URL，
   * 再用 rewrite 把公开前缀剥离后交给既有页面和 Route Handler。这样同一份代码既能在
   * 根路径开发，也能在生产反向代理前缀下提供完全相同的 `/api/v1` 契约。
   *
   * 改动 `basePath`、删除 rewrite 或改变规则顺序，都会破坏已上线前端、Location 响应头、
   * media_url 和 OpenAPI 文档中的实际调用地址。除非发布新的 API 大版本并完成调用方迁移，
   * 否则不得改变这套设计。
   */
  basePath: undefined,
  assetPrefix: publicBasePath || undefined,
  async rewrites() {
    const prefix = publicBasePath;
    if (!prefix) return [];
    return [
      { source: `${prefix}/:path*`, destination: "/:path*" },
      { source: `${prefix}`, destination: "/" },
    ];
  },
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
