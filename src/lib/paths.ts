export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const apiV1Path = (path: string) => `${APP_BASE_PATH}/api/v1${path}`;

export const appUrl = (path: string) => `${APP_BASE_PATH}${path}`;
