import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "@/server/config";
import { loadConfig } from "@/server/config";
import type {
  ApiV1Service,
  ReceiveUploadItemInput,
} from "@/server/api/v1/service";
import { getApiV1Service } from "@/server/api/v1/service";
import { ApiV1Error } from "@/server/api/errors";
import {
  inspectIngestSource,
  resolveIngestSource,
  type IngestSourceDescriptor,
} from "@/server/mcp/url-ingest";
import { targetFormatFromFilename } from "@/server/media/target-format";
import { getMcpRequestUserId } from "@/server/mcp/user-context";
import { resolveMcpAssetScope } from "@/server/mcp/scope";
import {
  databaseMcpIdempotencyStore,
  type McpIdempotencyStore,
} from "@/server/mcp/idempotency";
import {
  addAuditFields,
  auditLog,
  elapsedMilliseconds,
  errorAuditFields,
  summarizeResult,
} from "@/server/observability/audit-log";

/** 把带假 origin 的绝对 URL 转为相对路径；客户端用已知服务地址拼接。 */
function relativeUrl(absolute: string) {
  try {
    const url = new URL(absolute);
    return `${url.pathname}${url.search}`;
  } catch {
    return absolute;
  }
}

function textResult(data: unknown) {
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

async function auditedToolCall<T>(
  toolName: string,
  input: unknown,
  handler: () => Promise<T> | T,
) {
  const started = process.hrtime.bigint();
  auditLog("mcp_tool_started", {
    tool_name: toolName,
    user_id: getMcpRequestUserId() ?? null,
    tool_input: input,
  });
  try {
    const result = await handler();
    auditLog("mcp_tool_completed", {
      tool_name: toolName,
      user_id: getMcpRequestUserId() ?? null,
      duration_ms: elapsedMilliseconds(started),
      tool_result: summarizeResult(result),
    });
    return result;
  } catch (error) {
    auditLog(
      "mcp_tool_failed",
      {
        tool_name: toolName,
        user_id: getMcpRequestUserId() ?? null,
        duration_ms: elapsedMilliseconds(started),
        ...errorAuditFields(error),
      },
      "warn",
    );
    throw error;
  }
}

function requireUserId(config: AppConfig) {
  // 优先使用请求头 x-request-userid（route 层已白名单校验），
  // 未携带时回退服务端默认值；两者都缺则拒绝执行。
  const userId = getMcpRequestUserId() ?? config.mcpDefaultUserId;
  if (!userId) {
    throw new ApiV1Error(
      "forbidden",
      "服务端未配置 MCP_DEFAULT_USER_ID 且请求未携带 x-request-userid，无法执行个人素材操作。",
      403,
    );
  }
  return userId;
}

function assertIngestSourceAllowed(
  filename: string,
  sizeBytes: number,
  config: AppConfig,
) {
  const target = targetFormatFromFilename(filename);
  if (!target) {
    throw new ApiV1Error(
      "unsupported_media_type",
      "仅支持 .jpg/.jpeg/.png/.webp/.mp4；请通过 filename 参数指定扩展名。",
      415,
    );
  }
  const limitBytes =
    target.mediaType === "video"
      ? config.MAX_VIDEO_BYTES
      : config.MAX_IMAGE_BYTES;
  if (sizeBytes > limitBytes) {
    throw new ApiV1Error(
      "file_too_large",
      `${filename} 大小 ${sizeBytes} 字节，超过 ${target.mediaType === "video" ? "视频" : "图片"}上限 ${limitBytes} 字节。`,
      413,
      [{ filename, size_bytes: sizeBytes, limit_bytes: limitBytes }],
    );
  }
}

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .optional()
  .describe("可选幂等键；同一用户、同一工具和相同参数重试时复用原任务");

async function runIdempotentWrite<T extends Record<string, unknown>>(
  store: McpIdempotencyStore,
  config: AppConfig,
  operation: string,
  userId: string,
  key: string | undefined,
  request: unknown,
  handler: () => Promise<T>,
) {
  return store.run(
    {
      operation,
      userId,
      key,
      request,
      retentionDays: config.TASK_RETENTION_DAYS,
    },
    handler,
  );
}

async function runUploadFromUrl(
  input: { url: string; filename?: string },
  config: AppConfig,
  service: ApiV1Service,
) {
  const userId = requireUserId(config);
  const totalStarted = process.hrtime.bigint();
  addAuditFields({
    user_id: userId,
    source_url: input.url,
    requested_filename: input.filename ?? null,
  });
  const sourceStarted = process.hrtime.bigint();
  const source = await resolveIngestSource(input.url, config);
  auditLog("mcp_upload_source_ready", {
    source_resolution_ms: elapsedMilliseconds(sourceStarted),
    source_size_bytes: source.sizeBytes,
    source_filename: source.filename,
  });
  try {
    const filename = input.filename?.trim() || source.filename;
    assertIngestSourceAllowed(filename, source.sizeBytes, config);
    const createStarted = process.hrtime.bigint();
    const task = await service.createUploadTask({
      user_id: userId,
      callback_url: null,
      items: [
        {
          filename,
          size_bytes: source.sizeBytes,
          content_type: null,
        },
      ],
    });
    addAuditFields({
      task_id: task.task_id,
      item_id: task.items[0]?.item_id ?? null,
      filename,
      expected_bytes: source.sizeBytes,
    });
    auditLog("mcp_upload_task_created", {
      task_id: task.task_id,
      item_id: task.items[0]?.item_id ?? null,
      duration_ms: elapsedMilliseconds(createStarted),
    });
    const item = task.items[0];
    const receiveInput: ReceiveUploadItemInput = {
      taskId: task.task_id,
      itemId: item.item_id,
      body: source.body,
      contentLength: source.sizeBytes,
      contentType: null,
    };
    const receiveStarted = process.hrtime.bigint();
    const received = await service.receiveUploadItem(receiveInput);
    auditLog("mcp_upload_body_received", {
      task_id: task.task_id,
      item_id: item.item_id,
      duration_ms: elapsedMilliseconds(receiveStarted),
      received_bytes: received.received_bytes,
      expected_bytes: source.sizeBytes,
      status: received.status,
      phase: received.phase,
    });
    if (received.status === "failed") {
      throw new ApiV1Error(
        "internal_error",
        received.error?.message ?? "素材写入失败。",
        500,
      );
    }
    const sealStarted = process.hrtime.bigint();
    const sealed = await service.sealUploadTask(task.task_id);
    auditLog("mcp_upload_task_sealed", {
      task_id: task.task_id,
      duration_ms: elapsedMilliseconds(sealStarted),
      total_duration_ms: elapsedMilliseconds(totalStarted),
      status: sealed.status,
      phase: sealed.phase,
    });
    return {
      task_id: task.task_id,
      status: sealed.status,
      phase: sealed.phase,
      note: "素材已接收并进入异步处理，请用 get_task_status 查询终态的公私素材 ID。",
    };
  } finally {
    await source.close().catch(() => undefined);
  }
}

interface BatchUrlItem {
  url: string;
  filename?: string;
}

async function runUploadBatchFromUrls(
  input: { items: BatchUrlItem[] },
  config: AppConfig,
  service: ApiV1Service,
) {
  const userId = requireUserId(config);
  const totalStarted = process.hrtime.bigint();
  const sources: Array<IngestSourceDescriptor & { filename: string }> = [];
  for (const item of input.items) {
    const source = await inspectIngestSource(item.url, config);
    const filename = item.filename?.trim() || source.filename;
    assertIngestSourceAllowed(filename, source.sizeBytes, config);
    sources.push({ ...source, filename });
  }

  const task = await service.createUploadTask({
    user_id: userId,
    callback_url: null,
    items: sources.map((source) => ({
      filename: source.filename,
      size_bytes: source.sizeBytes,
      content_type: null,
    })),
  });
  addAuditFields({
    task_id: task.task_id,
    user_id: userId,
    upload_item_count: sources.length,
    upload_total_bytes: sources.reduce((sum, source) => sum + source.sizeBytes, 0),
  });

  for (const [index, descriptor] of sources.entries()) {
    const taskItem = task.items[index];
    if (!taskItem) throw new Error(`上传任务缺少第 ${index + 1} 个 item。`);
    const openStarted = process.hrtime.bigint();
    const source = await descriptor.open();
    auditLog("mcp_batch_source_opened", {
      task_id: task.task_id,
      item_id: taskItem.item_id,
      item_index: index,
      filename: descriptor.filename,
      duration_ms: elapsedMilliseconds(openStarted),
    });
    try {
      await service.receiveUploadItem({
        taskId: task.task_id,
        itemId: taskItem.item_id,
        body: source.body,
        contentLength: descriptor.sizeBytes,
        contentType: null,
      });
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  const sealed = await service.sealUploadTask(task.task_id);
  auditLog("mcp_upload_task_sealed", {
    task_id: task.task_id,
    total_duration_ms: elapsedMilliseconds(totalStarted),
    status: sealed.status,
    phase: sealed.phase,
    total_items: sources.length,
  });
  return {
    task_id: task.task_id,
    status: sealed.status,
    phase: sealed.phase,
    total_items: sources.length,
    note: "全部文件已接收并进入异步处理，请用 list_tasks 或 get_task_status 查询终态的公私素材 ID。",
  };
}

/** 组装并注册全部 MCP 工具。server 实例由调用方持有。 */
export function registerTools(
  server: McpServer,
  config: AppConfig = loadConfig(),
  service: ApiV1Service = getApiV1Service(),
  idempotencyStore: McpIdempotencyStore = databaseMcpIdempotencyStore,
) {
  const userId = () => requireUserId(config);
  const internalOrigin = process.env.API_INTERNAL_ORIGIN?.trim();
  if (!internalOrigin) {
    throw new Error("API_INTERNAL_ORIGIN must be configured for MCP tools.");
  }

  server.registerTool(
    "get_service_info",
    {
      title: "获取服务信息",
      description:
        "返回素材库服务信息：支持的媒体类型、图片/视频大小上限、当前调用方的 user_id。",
    },
    async () => auditedToolCall("get_service_info", {}, () =>
      textResult({
        service: "assets-library",
        supported_extensions: [".jpg", ".jpeg", ".png", ".webp", ".mp4"],
        max_image_bytes: config.MAX_IMAGE_BYTES,
        max_video_bytes: config.MAX_VIDEO_BYTES,
        // 当前请求身份：x-request-userid 优先，其次服务端默认值。
        user_id: getMcpRequestUserId() ?? config.mcpDefaultUserId ?? null,
        // 任意用户模式下 agent 可访问全部注册用户。
        any_user_access: config.mcpAllowAnyUserId,
      }),
    ),
  );

  server.registerTool(
    "list_users",
    {
      title: "列出注册用户",
      description:
        "列出 users 注册表中的可访问用户、资料字段与有效素材数；包含素材数为 0 的用户。任意用户模式下返回全部用户，白名单模式下仅返回允许的用户。",
    },
    async () => auditedToolCall("list_users", {}, async () => {
      const allUsers = await service.listUsers();
      const visible =
        config.mcpAllowAnyUserId
          ? allUsers
          : allUsers.filter((user) =>
              config.mcpAllowedUserIds.includes(user.user_id),
            );
      return textResult({ users: visible });
    }),
  );

  server.registerTool(
    "upload_from_url",
    {
      title: "从 URL 上传素材",
      description:
        "从可达 URL（白名单域名）拉取图片或视频并提交异步入库任务，立即返回 task_id；随后用 get_task_status 查询终态和素材 ID。",
      inputSchema: z.object({
        url: z.string().url().describe("文件的可达 URL（http/https，白名单域名）"),
        filename: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe("可选，覆盖文件名；扩展名决定媒体类型"),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ url, filename, idempotency_key }) => auditedToolCall(
      "upload_from_url",
      { url, filename, idempotency_key },
      async () => {
        const currentUserId = userId();
        const result = await runIdempotentWrite(
          idempotencyStore,
          config,
          "upload_from_url",
          currentUserId,
          idempotency_key,
          { url, filename },
          () => runUploadFromUrl({ url, filename }, config, service),
        );
        return textResult(result);
      },
    ),
  );

  server.registerTool(
    "upload_batch_from_urls",
    {
      title: "批量从 URL 上传素材",
      description:
        "从白名单 URL 批量拉取 1–100 个图片/视频，在一个任务中封存。",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              url: z.string().url().describe("文件的可达 URL"),
              filename: z
                .string()
                .trim()
                .min(1)
                .max(255)
                .optional()
                .describe("可选，覆盖 URL 推断的文件名"),
            }),
          )
          .min(1)
          .max(config.UPLOAD_MAX_ITEMS),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ items, idempotency_key }) => auditedToolCall(
      "upload_batch_from_urls",
      { items, idempotency_key },
      async () => {
        const currentUserId = userId();
        const result = await runIdempotentWrite(
          idempotencyStore,
          config,
          "upload_batch_from_urls",
          currentUserId,
          idempotency_key,
          { items },
          () => runUploadBatchFromUrls({ items }, config, service),
        );
        return textResult(result);
      },
    ),
  );

  server.registerTool(
    "get_task_status",
    {
      title: "查询任务状态",
      description: "查询上传/更新/发布/重试/删除异步任务的状态。",
      inputSchema: z.object({
        task_id: z.string().uuid().describe("任务 ID"),
      }),
    },
    async ({ task_id }) => auditedToolCall(
      "get_task_status",
      { task_id },
      async () => textResult(await service.getTask(task_id, userId())),
    ),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "列出我的任务",
      description:
        "按创建时间倒序列出当前用户的任务及逐文件状态，供 agent 重启后恢复 task_id、进度、错误和公私素材 ID。",
      inputSchema: z.object({
        statuses: z
          .array(z.enum(["queued", "running", "done", "failed"]))
          .max(4)
          .optional(),
        task_types: z
          .array(z.enum(["upload", "delete", "publish", "update", "retry"]))
          .max(5)
          .optional(),
        cursor: z.string().min(1).max(2048).nullable().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
    async ({ statuses, task_types, cursor, limit }) => auditedToolCall(
      "list_tasks",
      { statuses, task_types, cursor, limit },
      async () =>
        textResult(
          await service.listTasks(userId(), {
            statuses,
            types: task_types,
            cursor: cursor ?? null,
            limit: limit ?? 10,
          }),
        ),
    ),
  );

  server.registerTool(
    "query_assets",
    {
      title: "查询素材",
      description:
        "语义搜索与过滤素材。scope 决定可见范围：own 仅本人、user 指定用户、public 仅公共、all 公共+所有用户（默认 own）。支持游标分页与标签统计。",
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(1_000)
          .optional()
          .describe("自然语言语义搜索描述"),
        keywords: z
          .array(z.string().trim().min(1).max(64))
          .max(10)
          .optional()
          .describe("标签候选粗筛关键词"),
        scope: z
          .enum(["own", "user", "public", "all"])
          .optional()
          .describe("可见范围，默认 own"),
        user_id: z
          .string()
          .trim()
          .min(1)
          .max(191)
          .optional()
          .describe("scope=user 时指定要查询的任意注册用户"),
        media_types: z
          .array(z.enum(["image", "video"]))
          .max(2)
          .optional(),
        tags: z
          .array(z.object({ category: z.string().max(64), value: z.string().max(128) }))
          .max(20)
          .optional(),
        cursor: z.string().min(1).max(2_048).nullable().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        include_tag_statistics: z.boolean().optional(),
      }),
    },
    async (input) => auditedToolCall("query_assets", input, async () => {
      const currentUserId = userId();
      const scope = input.scope === "public"
        ? { mode: "exclude_user" as const, user_id: currentUserId }
        : resolveMcpAssetScope(input, currentUserId, config, { allowAll: true });
      const result = await service.queryAssets({
        query: input.query,
        keywords: input.keywords,
        filter: {
          user_scope: scope,
          media_types: input.media_types,
          tags: input.tags,
        },
        cursor: input.cursor ?? null,
        limit: input.limit ?? 20,
        include_tag_statistics: input.include_tag_statistics ?? true,
      });
      return textResult(result);
    }),
  );

  server.registerTool(
    "get_asset",
    {
      title: "获取素材详情",
      description:
        "获取单个素材详情，包含绝对分镜秒数及 VLM 分析结果（描述、标签、OCR、视频时间线）。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        scope: z
          .enum(["own", "user", "public"])
          .optional()
          .describe("可见范围，默认 own"),
        user_id: z
          .string()
          .trim()
          .min(1)
          .max(191)
          .optional()
          .describe("scope=user 时指定目标用户"),
      }),
    },
    async ({ asset_id, scope, user_id }) => auditedToolCall(
      "get_asset",
      { asset_id, scope, user_id },
      async () => {
        const finalScope = resolveMcpAssetScope(
          { scope, user_id },
          userId(),
          config,
        );
        return textResult(await service.getAsset(asset_id, finalScope));
      },
    ),
  );

  server.registerTool(
    "update_asset",
    {
      title: "更新素材",
      description: "提交异步任务，整体替换素材名称、描述与人工标签。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        name: z.string().trim().min(1).max(255).describe("素材名称"),
        description: z.string().max(10_000).describe("素材描述"),
        tags: z
          .array(z.object({ category: z.string().max(64), value: z.string().max(128) }))
          .max(100)
          .describe("人工标签"),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ asset_id, name, description, tags, idempotency_key }) => auditedToolCall(
      "update_asset",
      { asset_id, name, description, tags, idempotency_key },
      async () => {
      const currentUserId = userId();
      const accepted = await runIdempotentWrite(
        idempotencyStore,
        config,
        "update_asset",
        currentUserId,
        idempotency_key,
        { asset_id, name, description, tags },
        () => service.updateAsset(asset_id, {
          user_id: currentUserId,
          callback_url: null,
          name,
          description,
          tags,
        }),
      );
      return textResult(accepted);
      },
    ),
  );

  server.registerTool(
    "publish_asset",
    {
      title: "发布素材",
      description: "提交异步任务，发布分析成功的公共素材；私人素材无需审核。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ asset_id, idempotency_key }) => auditedToolCall(
      "publish_asset",
      { asset_id, idempotency_key },
      async () => {
      const currentUserId = userId();
      const accepted = await runIdempotentWrite(
        idempotencyStore,
        config,
        "publish_asset",
        currentUserId,
        idempotency_key,
        { asset_id },
        () => service.publishAsset(asset_id, {
          user_id: null,
          callback_url: null,
        }),
      );
      return textResult(accepted);
      },
    ),
  );

  server.registerTool(
    "retry_asset",
    {
      title: "重试素材分析",
      description: "提交异步任务，重试分析失败的素材。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ asset_id, idempotency_key }) => auditedToolCall(
      "retry_asset",
      { asset_id, idempotency_key },
      async () => {
      const currentUserId = userId();
      const accepted = await runIdempotentWrite(
        idempotencyStore,
        config,
        "retry_asset",
        currentUserId,
        idempotency_key,
        { asset_id },
        () => service.retryAsset(asset_id, {
          user_id: currentUserId,
          callback_url: null,
        }),
      );
      return textResult(accepted);
      },
    ),
  );

  server.registerTool(
    "delete_asset",
    {
      title: "删除素材",
      description:
        "永久删除本人私人素材、分析和存储对象，不影响配对的公共副本。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        idempotency_key: idempotencyKeySchema,
      }),
    },
    async ({ asset_id, idempotency_key }) => auditedToolCall(
      "delete_asset",
      { asset_id, idempotency_key },
      async () => {
      const currentUserId = userId();
      const accepted = await runIdempotentWrite(
        idempotencyStore,
        config,
        "delete_asset",
        currentUserId,
        idempotency_key,
        { asset_id },
        () => service.deleteAsset(asset_id, {
          user_id: currentUserId,
          callback_url: null,
        }),
      );
      return textResult(accepted);
      },
    ),
  );

  server.registerTool(
    "list_user_media",
    {
      title: "列出我的素材",
      description: "分页列出当前调用方的素材展示列表（含媒体直链与缩略图 URL）。",
      inputSchema: z.object({
        cursor: z.string().min(1).max(2_048).nullable().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ cursor, limit }) => auditedToolCall(
      "list_user_media",
      { cursor, limit },
      async () => {
      const result = await service.listUserMedia(
        userId(),
        { cursor: cursor ?? null, limit: limit ?? 20 },
        internalOrigin,
      );
      return textResult({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          media_url: relativeUrl(item.media_url),
          ...(item.media_type === "video"
            ? { thumbnail_url: relativeUrl(item.thumbnail_url) }
            : {}),
        })),
      });
      },
    ),
  );

  server.registerTool(
    "get_storage_usage",
    {
      title: "获取存储用量",
      description: "返回当前调用方的存储用量统计（文件数、字节数、逐素材明细）。",
    },
    async () => auditedToolCall(
      "get_storage_usage",
      {},
      async () => textResult(await service.getUserStorageUsage(userId())),
    ),
  );

  server.registerTool(
    "get_media_links",
    {
      title: "获取媒体链接",
      description:
        "返回素材的媒体路径与原始文件名；视频同时返回 thumbnail_url。scope 权限规则与 query_assets 一致。",
      inputSchema: z.object({
        asset_id: z.string().uuid().describe("素材 ID"),
        scope: z
          .enum(["own", "user", "public"])
          .optional()
          .describe("可见范围，默认 own"),
        user_id: z
          .string()
          .trim()
          .min(1)
          .max(191)
          .optional()
          .describe("scope=user 时指定目标用户"),
      }),
    },
    async ({ asset_id, scope, user_id }) => auditedToolCall(
      "get_media_links",
      { asset_id, scope, user_id },
      async () => {
        const finalScope = resolveMcpAssetScope(
          { scope, user_id },
          userId(),
          config,
        );
        const detail = await service.getAsset(asset_id, finalScope);
        const mediaUrl = relativeUrl(detail.media_url);
        return textResult({
          asset_id,
          media_url: mediaUrl,
          ...(detail.media_type === "video"
            ? {
                thumbnail_url: mediaUrl.replace(
                  `/media/${asset_id}`,
                  `/media/${asset_id}/thumbnail`,
                ),
              }
            : {}),
          original_filename: detail.original_filename,
        });
      },
    ),
  );
}
