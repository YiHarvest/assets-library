export const BACKEND_REQUEST_TIMEOUT_MS = 60_000;

/** Never expose Node/Undici timeout text directly in the rendered page. */
export function friendlyServerApiError(error: unknown, timedOut = false) {
  const name = error instanceof Error ? error.name : "";
  if (timedOut || name === "TimeoutError") {
    return new Error("后端响应超时，请稍后重试。");
  }
  if (name === "AbortError") {
    return new Error("请求已取消，请稍后重试。");
  }
  return error instanceof Error ? error : new Error("后端请求失败，请稍后重试。");
}
