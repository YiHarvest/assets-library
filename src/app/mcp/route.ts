import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppConfig } from "@/server/config";
import { loadConfig } from "@/server/config";
import { registerTools } from "@/server/mcp/tools";
import { mcpUserContext } from "@/server/mcp/user-context";
import {
  auditLog,
  elapsedMilliseconds,
  errorAuditFields,
  requestAuditFields,
  runWithAuditContext,
} from "@/server/observability/audit-log";

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

async function mcpRequestDescriptor(request: Request) {
  if (request.method !== "POST") return { rpc_method: request.method };
  try {
    const payload = (await request.clone().json()) as {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown };
    };
    return {
      rpc_method:
        typeof payload.method === "string" ? payload.method : "unknown",
      rpc_id:
        typeof payload.id === "string" || typeof payload.id === "number"
          ? payload.id
          : null,
      requested_tool:
        typeof payload.params?.name === "string" ? payload.params.name : null,
    };
  } catch {
    return { rpc_method: "invalid_json" };
  }
}

async function routeMcpRequest(request: Request) {
  const started = process.hrtime.bigint();
  const suppliedRequestId = request.headers.get("x-request-id");
  const requestId =
    suppliedRequestId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      suppliedRequestId,
    )
      ? suppliedRequestId
      : crypto.randomUUID();
  const descriptor = await mcpRequestDescriptor(request);
  const config = loadConfig();
  const context = {
    requestId,
    channel: "mcp" as const,
    operation:
      typeof descriptor.requested_tool === "string"
        ? `mcp:${descriptor.requested_tool}`
        : `mcp:${descriptor.rpc_method}`,
    fields: {
      ...requestAuditFields(request),
      ...descriptor,
    },
  };
  return runWithAuditContext(
    context,
    async () => {
      const denied = authorize(request, config);
      if (denied) {
        auditLog("mcp_request_rejected", {
          http_status: denied.status,
          duration_ms: elapsedMilliseconds(started),
          rejection: denied.status === 401 ? "unauthorized" : "not_configured",
        }, "warn");
        return denied;
      }
      const userId = resolveRequestUserId(request, config);
      if (userId instanceof Response) {
        auditLog("mcp_request_rejected", {
          http_status: userId.status,
          duration_ms: elapsedMilliseconds(started),
          rejection: "user_id_not_allowed",
        }, "warn");
        return userId;
      }

      auditLog("mcp_request_started", { user_id: userId || null });
      try {
        const response = await mcpUserContext.run(userId || undefined, () =>
          handleMcpRequest(request),
        );
        const headers = new Headers(response.headers);
        headers.set("x-request-id", requestId);
        auditLog("mcp_response_opened", {
          user_id: userId || null,
          http_status: response.status,
          duration_to_headers_ms: elapsedMilliseconds(started),
        });
        if (!response.body) {
          auditLog("mcp_request_completed", {
            user_id: userId || null,
            http_status: response.status,
            duration_ms: elapsedMilliseconds(started),
            response_streamed: false,
          });
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        const reader = response.body.getReader();
        let finalized = false;
        const logFinal = (
          event: "mcp_request_completed" | "mcp_request_cancelled" | "mcp_request_failed",
          fields: Record<string, unknown> = {},
          level: "info" | "warn" | "error" = "info",
        ) => {
          if (finalized) return;
          finalized = true;
          runWithAuditContext(context, () =>
            auditLog(
              event,
              {
                user_id: userId || null,
                http_status: response.status,
                duration_ms: elapsedMilliseconds(started),
                response_streamed: true,
                ...fields,
              },
              level,
            ),
          );
        };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                logFinal("mcp_request_completed");
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              logFinal("mcp_request_failed", errorAuditFields(error), "error");
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            logFinal(
              "mcp_request_cancelled",
              { cancel_reason: reason instanceof Error ? reason.message : reason },
              "warn",
            );
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        auditLog("mcp_request_failed", {
          user_id: userId || null,
          duration_ms: elapsedMilliseconds(started),
          ...errorAuditFields(error),
        }, "error");
        throw error;
      }
    },
  );
}

export async function POST(request: Request) {
  return routeMcpRequest(request);
}

export async function GET(request: Request) {
  return routeMcpRequest(request);
}
