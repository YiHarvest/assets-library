import type { NextConfig } from "next";

const backendOrigin = (process.env.BACKEND_URL || "http://127.0.0.1:23017").replace(
  /\/+$/,
  "",
);
const publicBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || "")
  .trim()
  .replace(/^\/+|\/+$/g, "");
const publicPrefix = publicBasePath ? `/${publicBasePath}` : "";

const backendRewrites = [
  {
    source: "/api/v1/:path*",
    destination: `${backendOrigin}/api/v1/:path*`,
  },
  {
    source: "/api/docs",
    destination: `${backendOrigin}/api/docs`,
  },
  {
    source: "/api/docs/:path*",
    destination: `${backendOrigin}/api/docs/:path*`,
  },
  {
    source: "/health",
    destination: `${backendOrigin}/health`,
  },
];

const nextConfig: NextConfig = {
  // 生产代理会剥离部署前缀，因此 Next 仍按根路径构建，只为静态资源增加前缀。
  assetPrefix: publicPrefix || undefined,
  // package scripts 将 dev/build 固定到 .next-dev/.next-prod；这里保留
  // NEXT_DIST_DIR 入口供检查任务使用，避免运行中的 dev 被 next build 覆盖。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    if (!publicPrefix) return backendRewrites;

    return [
      // 生产反向代理可以继续剥离前缀；本地直接访问 Next 时则在这里
      // 接受同一个公开前缀，API 优先转发到 Nest，其余页面和静态资源
      // 去掉前缀后交给 Next 路由。
      ...backendRewrites.map((rewrite) => ({
        ...rewrite,
        source: `${publicPrefix}${rewrite.source}`,
      })),
      {
        source: publicPrefix,
        destination: "/",
      },
      {
        source: `${publicPrefix}/:path*`,
        destination: "/:path*",
      },
      ...backendRewrites,
    ];
  },
};

export default nextConfig;
