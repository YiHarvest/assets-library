/**
 * 外部 API 兼容性边界。
 *
 * 线上调用方固定使用 `NEXT_PUBLIC_BASE_PATH/api/v1/**`，其部署前缀来自
 * NEXT_PUBLIC_BASE_PATH 环境变量。所有返回给调用方的 API、Location、media_url 和页面 URL
 * 必须经这里生成，禁止在业务代码中手写、移除或重复拼接 basePath。
 */
export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const apiV1Path = (path: string) => `${APP_BASE_PATH}/api/v1${path}`;

export const appUrl = (path: string) => `${APP_BASE_PATH}${path}`;
