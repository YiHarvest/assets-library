export const HTTP_REQUEST_TIMEOUT_MS = 60_000;
export const HTTP_HEADERS_TIMEOUT_MS = 15_000;

export interface HttpServerTimeouts {
  requestTimeout: number;
  headersTimeout: number;
}

/**
 * Node requestTimeout 限制从连接建立到完整请求体接收完毕的时间。
 * 它不影响响应返回后的 worker 作业，也不替代媒体处理阶段的 AbortSignal。
 */
export function configureHttpServerTimeouts(server: HttpServerTimeouts) {
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
}
