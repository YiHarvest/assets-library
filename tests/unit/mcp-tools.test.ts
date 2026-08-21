import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "@/server/config";
import type { ApiV1Service } from "@/server/api/v1/service";
import { registerTools } from "@/server/mcp/tools";
import type { McpIdempotencyStore } from "@/server/mcp/idempotency";

function testConfig(): AppConfig {
  return {
    MAX_IMAGE_BYTES: 20 * 1024 * 1024,
    MAX_VIDEO_BYTES: 200 * 1024 * 1024,
    UPLOAD_MAX_ITEMS: 100,
    UPLOAD_MAX_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
    TASK_RETENTION_DAYS: 7,
    mcpDefaultUserId: "user_mcp_test",
    mcpAccessToken: undefined,
    mcpAllowedDomains: [],
    mcpAllowedUserIds: ["user_mcp_test", "user-a"],
    mcpAllowAnyUserId: false,
    ZOS_WEB_URL: "https://zos-web.example.com",
    ZOS_INTERNAL_URL: "https://storage.example.com",
  } as unknown as AppConfig;
}

async function connectedClient(
  config: AppConfig,
  service?: ApiV1Service,
  idempotencyStore?: McpIdempotencyStore,
) {
  const server = new McpServer(
    { name: "assets-library-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, config, service, idempotencyStore);
  const client = new Client(
    { name: "mcp-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("MCP tool registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the full expected tool set", async () => {
    const server = new McpServer(
      { name: "assets-library-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, testConfig());

    const client = new Client(
      { name: "mcp-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

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
    await client.close();
  });

  it("exposes input schemas for parameterized tools", async () => {
    const server = new McpServer(
      { name: "assets-library-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, testConfig());

    const client = new Client(
      { name: "mcp-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const { tools } = await client.listTools();
    const upload = tools.find((tool) => tool.name === "upload_from_url");
    expect(upload?.inputSchema).toBeDefined();
    expect(upload?.inputSchema?.properties).toHaveProperty("url");
    expect(upload?.inputSchema?.properties).toHaveProperty("filename");
    expect(upload?.inputSchema?.properties).toHaveProperty("idempotency_key");
    expect(upload?.inputSchema?.required).toContain("url");

    const zeroArg = tools.find((tool) => tool.name === "get_service_info");
    // SDK 对无参工具也返回空的 inputSchema 对象，properties 应为空。
    expect(zeroArg?.inputSchema?.properties ?? {}).toEqual({});
    await client.close();
  });

  it("lists users from the registry, including zero-asset users, within the whitelist", async () => {
    const now = "2026-08-20T09:02:03.000+08:00";
    const listUsers = vi.fn(async () => [
      {
        user_id: "user-a",
        display_name: "用户 A",
        email: "user-a@example.com",
        department: "剪辑",
        first_seen_at: now,
        last_seen_at: now,
        asset_count: 0,
      },
      {
        user_id: "blocked-user",
        display_name: null,
        email: null,
        department: null,
        first_seen_at: now,
        last_seen_at: now,
        asset_count: 9,
      },
    ]);
    const service = { listUsers } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    const result = await client.callTool({ name: "list_users" });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(payload.users).toEqual([
      expect.objectContaining({
        user_id: "user-a",
        display_name: "用户 A",
        asset_count: 0,
      }),
    ]);
    await client.close();
  });

  it("binds task status to the current MCP user", async () => {
    const taskId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const getTask = vi.fn(async () => ({ task_id: taskId }));
    const service = { getTask } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    await client.callTool({
      name: "get_task_status",
      arguments: { task_id: taskId },
    });
    expect(getTask).toHaveBeenCalledWith(taskId, "user_mcp_test");
    await client.close();
  });

  it("rejects scope=all when arbitrary-user access is disabled", async () => {
    const queryAssets = vi.fn();
    const service = { queryAssets } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    const result = await client.callTool({
      name: "query_assets",
      arguments: { scope: "all" },
    });
    expect(result.isError).toBe(true);
    expect(queryAssets).not.toHaveBeenCalled();
    await client.close();
  });

  it("returns media and video thumbnail links as origin-independent relative URLs", async () => {
    const assetId = "00000000-0000-4000-8000-000000000001";
    const getAsset = vi.fn(async () => ({
      media_url: `https://internal.example.test/api/v1/media/${assetId}?user_id=user-a`,
      original_filename: "clip.mp4",
      media_type: "video",
    }));
    const service = { getAsset } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    const result = await client.callTool({
      name: "get_media_links",
      arguments: { asset_id: assetId },
    });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(payload.media_url).toBe(
      `/api/v1/media/${assetId}?user_id=user-a`,
    );
    expect(payload.thumbnail_url).toBe(
      `/api/v1/media/${assetId}/thumbnail?user_id=user-a`,
    );
    expect(payload.original_filename).toBe("clip.mp4");
    await client.close();
  });

  it("uses the shared scope rules for get_asset scope=user", async () => {
    const assetId = "00000000-0000-4000-8000-000000000001";
    const getAsset = vi.fn(async () => ({ asset_id: assetId }));
    const service = { getAsset } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    await client.callTool({
      name: "get_asset",
      arguments: { asset_id: assetId, scope: "user", user_id: "user-a" },
    });
    expect(getAsset).toHaveBeenCalledWith(assetId, {
      mode: "user",
      user_id: "user-a",
    });
    await client.close();
  });

  it("lists current-user tasks for agent recovery", async () => {
    const listTasks = vi.fn(async () => ({
      items: [],
      next_cursor: null,
      has_more: false,
    }));
    const service = { listTasks } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service);

    await client.callTool({
      name: "list_tasks",
      arguments: { statuses: ["failed"], limit: 5 },
    });
    expect(listTasks).toHaveBeenCalledWith("user_mcp_test", {
      statuses: ["failed"],
      types: undefined,
      cursor: null,
      limit: 5,
    });
    await client.close();
  });

  it("passes write calls through the idempotency store", async () => {
    const taskId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const publishAsset = vi.fn(async () => ({ task_id: taskId }));
    const run = vi.fn(async (_input, handler) => handler());
    const service = { publishAsset } as unknown as ApiV1Service;
    const client = await connectedClient(testConfig(), service, {
      run,
    } as McpIdempotencyStore);

    await client.callTool({
      name: "publish_asset",
      arguments: { asset_id: taskId, idempotency_key: "publish-once" },
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "publish_asset",
        userId: "user_mcp_test",
        key: "publish-once",
      }),
      expect.any(Function),
    );
    expect(publishAsset).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("creates one manifest and seals once for a batch URL upload", async () => {
    const taskId = "00000000-0000-4000-8000-000000000010";
    const itemIds = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) =>
        init.method === "HEAD"
          ? new Response(null, { headers: { "content-length": "3" } })
          : new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-length": "3" },
            }),
      ),
    );
    const createUploadTask = vi.fn(async () => ({
      task_id: taskId,
      items: itemIds.map((item_id) => ({ item_id })),
    }));
    const receiveUploadItem = vi.fn(async () => ({ status: "queued" }));
    const sealUploadTask = vi.fn(async () => ({
      status: "running",
      phase: "validating",
    }));
    const service = {
      createUploadTask,
      receiveUploadItem,
      sealUploadTask,
    } as unknown as ApiV1Service;
    const config = testConfig();
    config.ZOS_WEB_URL = "";
    config.ZOS_INTERNAL_URL = "";
    config.mcpAllowedDomains = ["cdn.example.com"];
    const client = await connectedClient(config, service);

    const result = await client.callTool({
      name: "upload_batch_from_urls",
      arguments: {
        items: [
          { url: "https://cdn.example.com/a.png", filename: "a.png" },
          { url: "https://cdn.example.com/b.mp4", filename: "b.mp4" },
        ],
        auto_publish: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(createUploadTask).toHaveBeenCalledWith({
      user_id: "user_mcp_test",
      callback_url: null,
      auto_publish: true,
      items: [
        { filename: "a.png", size_bytes: 3, content_type: null },
        { filename: "b.mp4", size_bytes: 3, content_type: null },
      ],
    });
    expect(receiveUploadItem).toHaveBeenCalledTimes(2);
    expect(sealUploadTask).toHaveBeenCalledTimes(1);
    expect(sealUploadTask).toHaveBeenCalledWith(taskId);
    await client.close();
  });
});
