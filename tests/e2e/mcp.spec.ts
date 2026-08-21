import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.E2E_BASE_URL?.trim();
if (!baseUrl) throw new Error("E2E_BASE_URL must be configured for MCP E2E tests.");
const mcpUrl = `${baseUrl}/mcp`;
const token = process.env.MCP_ACCESS_TOKEN?.trim();

function initializePayload() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0.0" },
    },
  });
}

function unauthorizedFetch(): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: initializePayload(),
  });
}

test("rejects requests without bearer token", async () => {
  const response = await unauthorizedFetch();
  expect(response.status).toBe(401);
});

test("rejects requests with a wrong bearer token", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrong-token-that-is-way-too-short",
    },
    body: initializePayload(),
  });
  expect(response.status).toBe(401);
});

test.skip(!token, "MCP_ACCESS_TOKEN 未配置，跳过握手与工具调用用例");

// 服务端 transport 是单例：一次 initialize 后同进程不能再 initialize。
// 因此握手、工具列表、身份注入、list_users、任意用户查询合并为单会话用例。
test("initializes, lists tools, and exercises user switching in one session", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        "x-request-userid": "user_clip",
      },
    },
  });
  const client = new Client(
    { name: "e2e-mcp-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  // 工具清单
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  expect(names).toEqual(
    [
      "delete_asset",
      "get_asset",
      "get_media_links",
      "get_service_info",
      "get_storage_usage",
      "get_task_status",
      "list_tasks",
      "list_user_media",
      "list_users",
      "publish_asset",
      "query_assets",
      "retry_asset",
      "update_asset",
      "upload_from_url",
      "upload_batch_from_urls",
    ].sort(),
  );

  // 服务信息：user_id 来自 x-request-userid，any_user_access 反映配置
  const info = await client.callTool({ name: "get_service_info" });
  const infoJson = JSON.parse(
    (info.content as Array<{ type: string; text: string }>)[0].text,
  );
  expect(infoJson.supported_extensions).toContain(".mp4");
  expect(infoJson.max_image_bytes).toBeGreaterThan(0);
  expect(infoJson.user_id).toBe("user_clip");
  const anyUser = Boolean(infoJson.any_user_access);

  // 公共查询
  const publicResult = await client.callTool({
    name: "query_assets",
    arguments: { scope: "public", limit: 5 },
  });
  const publicJson = JSON.parse(
    (publicResult.content as Array<{ type: string; text: string }>)[0].text,
  );
  expect(publicJson).toHaveProperty("items");
  expect(Array.isArray(publicJson.items)).toBe(true);

  // 列出注册用户
  const usersResult = await client.callTool({ name: "list_users" });
  const usersJson = JSON.parse(
    (usersResult.content as Array<{ type: string; text: string }>)[0].text,
  );
  expect(Array.isArray(usersJson.users)).toBe(true);
  if (usersJson.users.length > 0) {
    const first = usersJson.users[0];
    expect(first).toHaveProperty("user_id");
    expect(first).toHaveProperty("asset_count");
    expect(first).toHaveProperty("display_name");
    expect(first).toHaveProperty("email");
    expect(first).toHaveProperty("department");
    expect(first).toHaveProperty("first_seen_at");
    expect(first).toHaveProperty("last_seen_at");
    // 用返回的第一个用户查询其素材（任意模式或白名单内均可）。
    const query = await client.callTool({
      name: "query_assets",
      arguments: { scope: "user", user_id: first.user_id, limit: 5 },
    });
    const queryJson = JSON.parse(
      (query.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(queryJson).toHaveProperty("items");
    expect(Array.isArray(queryJson.items)).toBe(true);
  } else if (!anyUser) {
    // 白名单模式且无用户数据：至少保证 own 查询可用。
    const own = await client.callTool({
      name: "query_assets",
      arguments: { scope: "own", limit: 5 },
    });
    const ownJson = JSON.parse(
      (own.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(ownJson).toHaveProperty("items");
  }

  await client.close();
});
