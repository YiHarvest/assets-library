import { AsyncLocalStorage } from "node:async_hooks";

type AuditLevel = "info" | "warn" | "error";
type AuditFields = Record<string, unknown>;

interface AuditContext {
  requestId: string;
  channel: "api" | "mcp" | "worker";
  operation: string;
  fields: AuditFields;
}

const auditContext = new AsyncLocalStorage<AuditContext>();
const redactedKey = /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key)/i;

function truncate(value: string, maximum = 512) {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}...[truncated]`;
}

export function safeUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return truncate(value, 256);
  }
}

function safeValue(value: unknown, key = "", depth = 0): unknown {
  if (redactedKey.test(key)) return "[redacted]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    if (/url$/i.test(key)) return safeUrl(value);
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorAuditFields(value);
  if (depth >= 4) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => safeValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result: AuditFields = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = safeValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return truncate(String(value));
}

export function errorAuditFields(error: unknown) {
  if (!(error instanceof Error)) {
    return { error_type: typeof error, error_message: truncate(String(error)) };
  }
  const candidate = error as Error & {
    code?: unknown;
    Code?: unknown;
    status?: unknown;
    cause?: unknown;
    details?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  };
  const cause = candidate.cause as { code?: unknown; message?: unknown } | undefined;
  return {
    error_type: error.name,
    error_code:
      typeof candidate.code === "string" || typeof candidate.code === "number"
        ? candidate.code
        : typeof candidate.Code === "string" || typeof candidate.Code === "number"
          ? candidate.Code
        : typeof cause?.code === "string" || typeof cause?.code === "number"
          ? cause.code
          : null,
    error_status:
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.$metadata?.httpStatusCode === "number"
          ? candidate.$metadata.httpStatusCode
          : null,
    error_request_id:
      typeof candidate.$metadata?.requestId === "string"
        ? candidate.$metadata.requestId
        : null,
    error_message: truncate(error.message),
    error_cause:
      typeof cause?.message === "string" ? truncate(cause.message) : null,
    error_details: safeValue(candidate.details, "details"),
  };
}

export function runWithAuditContext<T>(
  context: Omit<AuditContext, "fields"> & { fields?: AuditFields },
  handler: () => T,
) {
  return auditContext.run(
    { ...context, fields: { ...(context.fields ?? {}) } },
    handler,
  );
}

export function addAuditFields(fields: AuditFields) {
  const context = auditContext.getStore();
  if (!context) return;
  Object.assign(context.fields, safeValue(fields) as AuditFields);
}

export function currentAuditFields() {
  const context = auditContext.getStore();
  return context ? { ...context.fields } : {};
}

export function auditLog(
  event: string,
  fields: AuditFields = {},
  level: AuditLevel = "info",
) {
  const context = auditContext.getStore();
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "assets-library",
    pid: process.pid,
    ...(context
      ? {
          request_id: context.requestId,
          channel: context.channel,
          operation: context.operation,
          ...context.fields,
        }
      : {}),
    ...(safeValue(fields) as AuditFields),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function requestAuditFields(request: Request) {
  const url = new URL(request.url);
  const forwardedFor = request.headers.get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return {
    http_method: request.method,
    http_path: url.pathname,
    query_keys: [...new Set(url.searchParams.keys())],
    caller_ip:
      forwardedFor ??
      request.headers.get("x-real-ip") ??
      request.headers.get("cf-connecting-ip") ??
      null,
    user_agent: request.headers.get("user-agent"),
    origin: safeUrl(request.headers.get("origin")),
    referer: safeUrl(request.headers.get("referer")),
    content_type: request.headers.get("content-type"),
    content_length: request.headers.get("content-length"),
    request_user_id: request.headers.get("x-request-userid")?.trim() || null,
  };
}

export function elapsedMilliseconds(started: bigint) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

export function summarizeResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return safeValue(value);
  const source = value as Record<string, unknown>;
  const structured =
    source.structuredContent && typeof source.structuredContent === "object"
      ? (source.structuredContent as Record<string, unknown>)
      : source;
  const result: AuditFields = {};
  for (const key of [
    "task_id",
    "task_type",
    "status",
    "phase",
    "asset_id",
    "user_id",
    "total_items",
    "done_items",
    "failed_items",
    "received_bytes",
    "total_bytes",
    "has_more",
  ]) {
    if (key in structured) result[key] = structured[key];
  }
  for (const key of ["items", "users", "tags"]) {
    const item = structured[key];
    if (Array.isArray(item)) result[`${key}_count`] = item.length;
  }
  return safeValue(result);
}
