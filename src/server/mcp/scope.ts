import type { AppConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import type { UserScope } from "@/shared/contracts";

export type McpAssetScope = "own" | "user" | "public" | "all";

export interface McpScopeInput {
  scope?: McpAssetScope;
  user_id?: string;
}

/**
 * MCP 素材读取的唯一权限解析入口。
 *
 * route 层负责校验当前调用身份；这里继续校验调用方指定的目标身份，避免
 * query/get/link 各自维护一份规则后发生漂移。
 */
export function resolveMcpAssetScope(
  input: McpScopeInput,
  currentUserId: string,
  config: AppConfig,
  options: { allowAll?: boolean } = {},
): UserScope {
  const scope = input.scope ?? "own";
  if (scope === "own") return { mode: "user", user_id: currentUserId };
  if (scope === "public") return { mode: "public" };
  if (scope === "all") {
    if (!options.allowAll) {
      throw new ApiV1Error("invalid_request", "此工具不支持 scope=all。", 400);
    }
    if (!config.mcpAllowAnyUserId) {
      throw new ApiV1Error(
        "forbidden",
        "scope=all 仅在 MCP_ALLOW_ANY_USER_ID=true 时可用。",
        403,
      );
    }
    return { mode: "all" };
  }

  const targetUserId = input.user_id?.trim();
  if (!targetUserId) {
    throw new ApiV1Error(
      "invalid_request",
      "scope=user 时必须提供 user_id。",
      400,
    );
  }
  if (
    !config.mcpAllowAnyUserId &&
    !config.mcpAllowedUserIds.includes(targetUserId)
  ) {
    throw new ApiV1Error(
      "forbidden",
      `user_id ${targetUserId} 不在允许访问范围内。`,
      403,
    );
  }
  return { mode: "user", user_id: targetUserId };
}
