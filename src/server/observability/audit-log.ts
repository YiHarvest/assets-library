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
const redactedKey = /(^key$|authorization|cookie|password|secret|token|signature|api[_-]?key|access[_-]?key)/i;

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
    // MCP text results contain JSON; redact their fields before logging the text.
    if (key === "text") {
      try { return safeValue(JSON.parse(value), "", depth + 1); } catch { /* Plain text. */ }
    }
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorAuditFields(value);
  if (depth >= 12) return "[max-depth]";
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
          ...(safeValue(context.fields) as AuditFields),
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
    query: Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    })),
    input: request.body ? { omitted: "body_not_parsed", content_type: request.headers.get("content-type"), content_length: request.headers.get("content-length") } : null,
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

/** Observe bytes already flowing to the client without cloning or buffering media. */
export function responseBodyAudit(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = /(?:\/|\+)json(?:;|$)/i.test(contentType);
  const isSse = contentType.startsWith("text/event-stream");
  const isText = contentType.startsWith("text/") || contentType.startsWith("application/yaml");
  // ponytail: capture at most 64 KiB per response; use a separate payload store if larger bodies are needed.
  const maximum = 64 * 1024;
  let bytes = 0;
  let chunks: Buffer[] = [];
  return {
    write(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes <= maximum && (isJson || isSse || isText)) chunks.push(Buffer.from(chunk));
      else chunks = [];
    },
    fields() {
      let output: unknown = null;
      if (response.body) {
        if (bytes > maximum) output = { omitted: "body_too_large", limit_bytes: maximum };
        else if (!isJson && !isSse && !isText) output = { omitted: "binary_body" };
        else {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            output = isJson ? JSON.parse(text) : isSse
              ? text.split(/\r?\n\r?\n/).filter((event) => /^data:/m.test(event)).map((event) =>
                  JSON.parse(event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")))
              : text;
          } catch {
            output = { omitted: "invalid_or_incomplete_json" };
          }
        }
      }
      return { output, response_bytes: bytes, response_content_type: contentType || null };
    },
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
