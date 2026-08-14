type ErrorLike = Error & {
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
  cause?: unknown;
};

/** 仅用于服务端日志；保留故障分类，不把连接串、请求体或堆栈回给调用方。 */
export function errorLogDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "UnknownError", message: String(error).slice(0, 2_000) };
  const value = error as ErrorLike;
  return {
    name: value.name,
    message: value.message.slice(0, 2_000),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.errno === "number" ? { errno: value.errno } : {}),
    ...(typeof value.sqlState === "string" ? { sql_state: value.sqlState } : {}),
    ...(depth < 2 && value.cause ? { cause: errorLogDetails(value.cause, depth + 1) } : {}),
  };
}
