import crypto from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { ApiV1Error } from "@/server/api/errors";
import type {
  ApiErrorDetail,
  ApiV1ErrorCode,
  ApiV1ErrorResponse,
} from "@/shared/contracts";
import { apiV1ErrorCodeSchema } from "@/shared/contracts";

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
          new ApiV1Error("internal_error", "系统处理失败，请稍后重试。", 500);
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
  try {
    authorize(request);
    const response = await handler();
    const headers = new Headers(response.headers);
    headers.set("x-request-id", id);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return apiV1ErrorResponse(error, id);
  }
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
  return schema.parse(value);
}

export async function parseOptionalJson<T>(
  request: Request,
  schema: ZodType<T>,
  emptyValue: unknown = {},
) {
  const text = await request.text();
  if (!text.trim()) return schema.parse(emptyValue);
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BODY_BYTES) {
    throw new ApiV1Error(
      "invalid_request",
      "JSON 请求体不得超过 1 MiB。",
      413,
    );
  }
  try {
    return schema.parse(JSON.parse(text));
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
