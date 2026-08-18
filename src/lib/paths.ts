/** 项目对外挂载的 basePath，与 next.config.ts 的 basePath 保持一致。 */
export const APP_BASE_PATH = "/feisu/assets-library";

export const apiV1Path = (path: string) => `${APP_BASE_PATH}/api/v1${path}`;