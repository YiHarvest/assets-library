import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 每个 MCP 请求的用户上下文。route handler 解析 `x-request-userid` 并校验
 * 白名单后写入；工具回调在同一异步链内读取，避免把 user_id 暴露为工具参数。
 */
export const mcpUserContext = new AsyncLocalStorage<string | undefined>();

export function getMcpRequestUserId(): string | undefined {
  return mcpUserContext.getStore();
}
