import crypto from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { ApiV1Error } from "@/server/api/errors";
import { isDeadlockError } from "@/server/db/retry";
import type {
  ApiErrorDetail,
  ApiV1ErrorCode,
  ApiV1ErrorResponse,
} from "@/shared/contracts";
import { apiV1ErrorCodeSchema } from "@/shared/contracts";
import { userIdSchema } from "@/shared/contracts";
import {
  addAuditFields,
  auditLog,
  elapsedMilliseconds,
  errorAuditFields,
  requestAuditFields,
  runWithAuditContext,
} from "@/server/observability/audit-log";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

type RequestId = ReturnType<typeof crypto.randomUUID>;

function requestId(request: Request): RequestId {
  const supplied = request.headers.get("x-request-id");
  return supplied &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      supplied,
    )
    ? (supplied as RequestId)
    : crypto.randomUUID();
}

function apiOperation(request: Request) {
  const pathname = new URL(request.url).pathname.replace(
    /^.*\/api\/v1(?=\/|$)/,
    "/api/v1",
  );
  const route = pathname.replace(
    /\/[0-9a-f]{8}-[0-9a-f-]{27,35}(?=\/|$)/gi,
    "/:id",
  );
  const operations: Record<string, string> = {
    "POST /api/v1/uploads": "create_upload_task",
    "PUT /api/v1/uploads/:id/items/:id": "upload_item_bytes",
    "POST /api/v1/uploads/:id": "seal_upload_task",
    "GET /api/v1/tasks/:id": "get_task_status",
    "POST /api/v1/compat/segment-match": "create_compatibility_match_task",
    "POST /api/v1/assets/query": "query_assets",
    "GET /api/v1/assets/:id": "get_asset",
    "PATCH /api/v1/assets/:id": "update_asset",
    "DELETE /api/v1/assets/:id": "delete_asset",
    "POST /api/v1/assets/:id/publish": "publish_asset",
    "POST /api/v1/assets/:id/retry": "retry_asset",
    "GET /api/v1/media/:id": "get_media",
    "GET /api/v1/media/:id/thumbnail": "get_thumbnail",
  };
  if (/^\/api\/v1\/users\/[^/]+\/media$/.test(route)) {
    return "list_user_media";
  }
  if (/^\/api\/v1\/users\/[^/]+\/storage-usage$/.test(route)) {
    return "get_storage_usage";
  }
  return operations[`${request.method} ${route}`] ?? `${request.method} ${route}`;
}

function apiPathFields(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^.*\/api\/v1(?=\/|$)/, "/api/v1");
  const fields: Record<string, unknown> = {};
  const uploadItem = pathname.match(
    /^\/api\/v1\/uploads\/([^/]+)\/items\/([^/]+)$/,
  );
  const uploadTask = pathname.match(/^\/api\/v1\/uploads\/([^/]+)$/);
  const task = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  const asset = pathname.match(
    /^\/api\/v1\/(?:assets|media)\/([0-9a-f]{8}-[0-9a-f-]{27,35})(?:\/|$)/i,
  );
  const user = pathname.match(/^\/api\/v1\/users\/([^/]+)\//);
  if (uploadItem) {
    fields.task_id = uploadItem[1];
    fields.item_id = uploadItem[2];
  } else if (uploadTask) fields.task_id = uploadTask[1];
  else if (task) fields.task_id = task[1];
  if (asset) fields.asset_id = asset[1];
  if (user) {
    try {
      fields.user_id = decodeURIComponent(user[1]!);
    } catch {
      fields.user_id = user[1];
    }
  }
  const queryUserId = url.searchParams.get("user_id");
  if (queryUserId !== null) fields.user_id = queryUserId;
  return fields;
}

function addParsedInputAuditFields(value: unknown) {
  const fields: Record<string, unknown> = { input: value };
  if (value && typeof value === "object") {
    const input = value as {
      user_id?: unknown;
      items?: unknown;
      filter?: { user_scope?: unknown };
    };
    if ("user_id" in input) fields.user_id = input.user_id ?? null;
    if (Array.isArray(input.items)) {
      fields.upload_item_count = input.items.length;
      fields.upload_total_bytes = input.items.reduce((total, item) => {
        if (!item || typeof item !== "object") return total;
        const size = (item as { size_bytes?: unknown }).size_bytes;
        return total + (typeof size === "number" ? size : 0);
      }, 0);
    }
    if (input.filter?.user_scope) {
      fields.user_scope = input.filter.user_scope;
    }
  }
  addAuditFields(fields);
}

function inheritedServiceError(error: unknown): ApiV1Error | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: unknown;
  };
  if (
    !apiV1ErrorCodeSchema.safeParse(candidate.code).success ||
    typeof candidate.message !== "string" ||
    typeof candidate.status !== "number" ||
    candidate.status < 400 ||
    candidate.status > 599
  ) {
    return null;
  }
  return new ApiV1Error(
    candidate.code as ApiV1ErrorCode,
    candidate.message,
    candidate.status,
    Array.isArray(candidate.details)
      ? (candidate.details as ApiErrorDetail[])
      : undefined,
  );
}

export function apiV1ErrorResponse(
  error: unknown,
  id: RequestId = crypto.randomUUID(),
) {
  const normalized =
    error instanceof ApiV1Error
      ? error
      : error instanceof ZodError
        ? new ApiV1Error(
            "invalid_request",
            error.issues[0]?.message ?? "请求字段无效。",
            400,
          )
        : inheritedServiceError(error) ??
          (isDeadlockError(error)
            ? new ApiV1Error(
                "conflict",
                "操作冲突，请稍后重试。",
                409,
              )
            : new ApiV1Error("internal_error", "系统处理失败，请稍后重试。", 500));
  const payload: ApiV1ErrorResponse = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
    request_id: id,
  };
  return Response.json(payload, {
    status: normalized.status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": id,
    },
  });
}

export async function withApiV1(
  request: Request,
  handler: () => Promise<Response> | Response,
  authorize: (request: Request) => void = () => undefined,
) {
  const id = requestId(request);
  const started = process.hrtime.bigint();
  const context = {
    requestId: id,
    channel: "api" as const,
    operation: apiOperation(request),
    fields: {
      ...requestAuditFields(request),
      ...apiPathFields(request),
    },
  };
  return runWithAuditContext(
    context,
    async () => {
      auditLog("api_request_started");
      try {
        authorize(request);
        const response = await handler();
        const headers = new Headers(response.headers);
        headers.set("x-request-id", id);
        const location = headers.get("location");
        auditLog("api_response_opened", {
          http_status: response.status,
          duration_to_headers_ms: elapsedMilliseconds(started),
          location,
        });
        if (!response.body) {
          auditLog("api_request_completed", {
            http_status: response.status,
            duration_ms: elapsedMilliseconds(started),
            response_streamed: false,
            location,
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
          event:
            | "api_request_completed"
            | "api_request_cancelled"
            | "api_response_stream_failed",
          fields: Record<string, unknown> = {},
          level: "info" | "warn" | "error" = "info",
        ) => {
          if (finalized) return;
          finalized = true;
          runWithAuditContext(context, () =>
            auditLog(
              event,
              {
                http_status: response.status,
                duration_ms: elapsedMilliseconds(started),
                response_streamed: true,
                location,
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
                logFinal("api_request_completed");
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              logFinal(
                "api_response_stream_failed",
                errorAuditFields(error),
                "error",
              );
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            logFinal(
              "api_request_cancelled",
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
        const response = apiV1ErrorResponse(error, id);
        auditLog(
          "api_request_failed",
          {
            http_status: response.status,
            duration_ms: elapsedMilliseconds(started),
            ...errorAuditFields(error),
          },
          response.status >= 500 ? "error" : "warn",
        );
        return response;
      }
    },
  );
}

export async function parseJson<T>(request: Request, schema: ZodType<T>) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ApiV1Error(
      "invalid_request",
      "JSON 请求体不得超过 1 MiB。",
      413,
    );
  }
  let value: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
      throw new ApiV1Error(
        "invalid_request",
        "JSON 请求体不得超过 1 MiB。",
        413,
      );
    }
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiV1Error) throw error;
    throw new ApiV1Error("invalid_request", "请求体必须是有效的 JSON。", 400);
  }
  const parsed = schema.parse(value);
  addParsedInputAuditFields(parsed);
  return parsed;
}

export async function parseOptionalJson<T>(
  request: Request,
  schema: ZodType<T>,
  emptyValue: unknown = {},
) {
  const text = await request.text();
  if (!text.trim()) {
    const parsed = schema.parse(emptyValue);
    addParsedInputAuditFields(parsed);
    return parsed;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
    throw new ApiV1Error(
      "invalid_request",
      "JSON 请求体不得超过 1 MiB。",
      413,
    );
  }
  try {
    const parsed = schema.parse(JSON.parse(text));
    addParsedInputAuditFields(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ZodError) throw error;
    throw new ApiV1Error("invalid_request", "请求体必须是有效的 JSON。", 400);
  }
}

export function parseUuid(value: string, field: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiV1Error("invalid_request", `${field} 必须是有效的 UUID。`, 400);
  }
  return value;
}

/** 路径参数可能仍含百分号编码；在服务层之前统一解码、去空白并限长。 */
export function parseUserIdPath(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiV1Error("invalid_request", "user_id 路径编码无效。", 400);
  }
  const parsed = userIdSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ApiV1Error(
      "invalid_request",
      parsed.error.issues[0]?.message ?? "user_id 无效。",
      400,
    );
  }
  return parsed.data;
}
