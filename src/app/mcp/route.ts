import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppConfig } from "@/server/config";
import { loadConfig } from "@/server/config";
import { registerTools } from "@/server/mcp/tools";
import { mcpUserContext } from "@/server/mcp/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = "Unauthorized";
const USER_ID_HEADER = "x-request-userid";

function tokenMatches(expected: string, provided: string) {
  const expectedHash = crypto
    .createHash("sha256")
    .update(expected)
    .digest();
  const providedHash = crypto
    .createHash("sha256")
    .update(provided)
    .digest();
  return crypto.timingSafeEqual(expectedHash, providedHash);
}

function authorize(request: Request, config: AppConfig): Response | null {
  if (!config.mcpConfigured || !config.mcpAccessToken) {
    // fail-closed：未配置 MCP token 时端点不可用，避免暴露无鉴权接口。
    return new Response("MCP endpoint is not configured.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  if (!provided || !tokenMatches(config.mcpAccessToken, provided)) {
    return new Response(UNAUTHORIZED, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  return null;
}

/**
 * 解析 `x-request-userid` 请求头并做白名单校验。
 * - 不带 header → 返回默认 user_id（可能 undefined，tools 层再兜底）。
 * - 带 header 但不在白名单 → 403，防止绕过隔离看别人的素材。
 * - 返回 Response 表示拒绝，字符串表示解析出的 user_id。
 */
function resolveRequestUserId(
  request: Request,
  config: AppConfig,
): Response | string {
  const requested = request.headers.get(USER_ID_HEADER)?.trim();
  if (!requested) return config.mcpDefaultUserId ?? "";
  if (requested.length > 191) {
    return new Response("x-request-userid 过长。", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  // 任意用户模式：token 持有者可代理任意 user_id（剪辑 agent 动态切换）。
  if (config.mcpAllowAnyUserId) return requested;
  if (!config.mcpAllowedUserIds.includes(requested)) {
    return new Response("x-request-userid 不在允许的 user_id 白名单内。", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  return requested;
}

/**
 * 每次请求创建独立的 transport 和 McpServer。
 * McpServer 只能 connect 一个 transport 一次；为了让多个客户端能并发连
 * 同一个端点，必须为每个请求新建 server 实例（无状态模式，不维护 session）。
 */
async function handleMcpRequest(request: Request): Promise<Response> {
  const config = loadConfig();
  const server = new McpServer(
    { name: "assets-library-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function POST(request: Request) {
  const config = loadConfig();
  const denied = authorize(request, config);
  if (denied) return denied;
  const userId = resolveRequestUserId(request, config);
  if (userId instanceof Response) return userId;

  return mcpUserContext.run(userId || undefined, () =>
    handleMcpRequest(request),
  );
}

export async function GET(request: Request) {
  const config = loadConfig();
  const denied = authorize(request, config);
  if (denied) return denied;
  const userId = resolveRequestUserId(request, config);
  if (userId instanceof Response) return userId;

  return mcpUserContext.run(userId || undefined, () =>
    handleMcpRequest(request),
  );
}
