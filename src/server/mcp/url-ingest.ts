import { isIP } from "node:net";
import type { AppConfig } from "@/server/config";
import { loadConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import { createZosObjectStorage } from "@/server/storage/zos";
import { normalizeObjectKey } from "@/server/storage/object-storage";
import {
  auditLog,
  elapsedMilliseconds,
  errorAuditFields,
  safeUrl,
} from "@/server/observability/audit-log";

/**
 * upload_from_url 的源 URL 解析。
 *
 * 安全模型：只允许精确命中白名单的域名，禁止任何 IP 直连（即使 IP 恰好
 * 命中白名单域名也不放行，域名与 IP 必须严格区分）。白名单默认来自
 * ZOS_WEB_URL / ZOS_INTERNAL_URL 的 host，可用 MCP_ALLOWED_DOMAINS 追加。
 *
 * - 同 bucket 域名：不发起 HTTP，直接用 S3 协议从 ZOS 拉流（内网 endpoint，
 *   不占用外网带宽）。
 * - 其他白名单域名：HTTP GET，逐跳校验重定向目标 host，最多 5 跳。
 */

const MAX_REDIRECT_HOPS = 5;

export interface IngestSource {
  /** 从 URL path 推断的文件名（可能无扩展名，工具层决定是否接受）。 */
  filename: string;
  /** 服务端已知的精确字节数（同桶来自 HEAD 对象，HTTP 来自 Content-Length）。 */
  sizeBytes: number;
  /** 已打开的响应体；调用方消费后必须调用 close() 释放。 */
  body: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
}

function hostnameOf(url: URL) {
  return url.hostname.toLowerCase();
}

function allowedHostnames(config: AppConfig) {
  const hosts = new Set<string>();
  for (const value of [config.ZOS_WEB_URL, config.ZOS_INTERNAL_URL]) {
    if (value) hosts.add(hostnameOf(new URL(value)));
  }
  for (const domain of config.mcpAllowedDomains) {
    const normalized = domain.trim().toLowerCase();
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

function assertAllowedHost(url: URL, allowed: Set<string>) {
  const host = hostnameOf(url);
  if (!host || isIP(host) !== 0) {
    throw new ApiV1Error(
      "invalid_request",
      "upload_from_url 只允许白名单域名，禁止 IP 直连。",
      400,
    );
  }
  if (!allowed.has(host)) {
    throw new ApiV1Error(
      "invalid_request",
      `源 URL 域名 ${host} 不在允许清单内。`,
      400,
    );
  }
}

function isSameBucketHost(host: string, config: AppConfig) {
  for (const value of [config.ZOS_WEB_URL, config.ZOS_INTERNAL_URL]) {
    if (value && hostnameOf(new URL(value)) === host) return true;
  }
  return false;
}

function filenameFromPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return "";
  }
  const segments = decoded.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

function objectKeyFromUrlPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ApiV1Error("invalid_request", "源 URL 路径编码无效。", 400);
  }
  const key = decoded.replace(/^\/+/, "");
  try {
    return normalizeObjectKey(key);
  } catch {
    throw new ApiV1Error(
      "invalid_request",
      "源 URL 无法解析为有效的对象 key。",
      400,
    );
  }
}

async function fetchWithRedirectGuard(
  url: URL,
  method: "GET" | "HEAD",
  allowed: Set<string>,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertAllowedHost(current, allowed);
    const started = process.hrtime.bigint();
    auditLog("mcp_source_request_started", {
      source_url: safeUrl(current.toString()),
      source_host: current.hostname,
      source_method: method,
      redirect_hop: hop,
    });
    let response: Response;
    try {
      response = await fetch(current, { method, redirect: "manual" });
    } catch (error) {
      auditLog(
        "mcp_source_request_failed",
        {
          source_url: safeUrl(current.toString()),
          source_host: current.hostname,
          source_method: method,
          redirect_hop: hop,
          duration_ms: elapsedMilliseconds(started),
          ...errorAuditFields(error),
        },
        "warn",
      );
      throw error;
    }
    auditLog("mcp_source_response_headers", {
      source_url: safeUrl(current.toString()),
      source_host: current.hostname,
      source_method: method,
      redirect_hop: hop,
      duration_ms: elapsedMilliseconds(started),
      http_status: response.status,
      content_length: response.headers.get("content-length"),
      content_type: response.headers.get("content-type"),
      content_encoding: response.headers.get("content-encoding"),
      transfer_encoding: response.headers.get("transfer-encoding"),
      accept_ranges: response.headers.get("accept-ranges"),
      response_server: response.headers.get("server"),
      response_via: response.headers.get("via"),
      response_cache: response.headers.get("x-cache"),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new ApiV1Error(
          "invalid_request",
          "源 URL 重定向缺少 Location 头。",
          400,
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ApiV1Error("invalid_request", "源 URL 重定向目标无效。", 400);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new ApiV1Error("invalid_request", "源 URL 仅支持 HTTP/HTTPS。", 400);
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new ApiV1Error(
        "invalid_request",
        `源 URL 请求失败：HTTP ${response.status}。`,
        400,
      );
    }
    return response;
  }
  throw new ApiV1Error("invalid_request", "源 URL 重定向次数过多。", 400);
}

async function resolveHttpSource(
  url: URL,
  config: AppConfig,
): Promise<IngestSource> {
  const allowed = allowedHostnames(config);
  const head = await fetchWithRedirectGuard(url, "HEAD", allowed);
  const declaredLength = Number(head.headers.get("content-length") ?? "0");
  if (head.body) await head.body.cancel().catch(() => undefined);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength <= 0 ||
    !head.headers.get("content-length")
  ) {
    throw new ApiV1Error(
      "invalid_request",
      "源 URL 必须返回 Content-Length（不支持 chunked 或未知长度）。",
      400,
    );
  }
  const response = await fetchWithRedirectGuard(url, "GET", allowed);
  if (!response.body) {
    throw new ApiV1Error("invalid_request", "源 URL 未返回可读响应体。", 400);
  }
  const actualLength = Number(response.headers.get("content-length") ?? "0");
  if (actualLength !== declaredLength) {
    await response.body.cancel().catch(() => undefined);
    throw new ApiV1Error(
      "invalid_request",
      "源 URL HEAD 与 GET 返回的大小不一致。",
      400,
    );
  }
  auditLog("mcp_source_resolved", {
    source_kind: "http",
    source_url: safeUrl(url.toString()),
    source_host: url.hostname,
    filename: filenameFromPath(url.pathname),
    size_bytes: declaredLength,
  });
  return {
    filename: filenameFromPath(url.pathname),
    sizeBytes: declaredLength,
    body: response.body,
    close: async () => {
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

async function resolveSameBucketSource(
  url: URL,
  config: AppConfig,
): Promise<IngestSource> {
  const key = objectKeyFromUrlPath(url.pathname);
  const storage = createZosObjectStorage(config);
  const headStarted = process.hrtime.bigint();
  let metadata: Awaited<ReturnType<typeof storage.headObject>>;
  try {
    metadata = await storage.headObject(key);
    auditLog("mcp_source_object_head_completed", {
      source_kind: "zos",
      source_host: url.hostname,
      object_key: key,
      size_bytes: metadata.sizeBytes,
      duration_ms: elapsedMilliseconds(headStarted),
    });
  } catch (error) {
    auditLog("mcp_source_object_head_failed", {
      source_kind: "zos",
      source_host: url.hostname,
      object_key: key,
      duration_ms: elapsedMilliseconds(headStarted),
      ...errorAuditFields(error),
    }, "warn");
    throw error;
  }
  const getStarted = process.hrtime.bigint();
  const result = await storage.getObject(key);
  auditLog("mcp_source_object_get_opened", {
    source_kind: "zos",
    source_host: url.hostname,
    object_key: key,
    size_bytes: metadata.sizeBytes,
    duration_ms: elapsedMilliseconds(getStarted),
  });
  if (!result.body) {
    throw new ApiV1Error("invalid_request", "ZOS 对象不可读。", 400);
  }
  auditLog("mcp_source_resolved", {
    source_kind: "zos",
    source_url: safeUrl(url.toString()),
    source_host: url.hostname,
    object_key: key,
    filename: filenameFromPath(url.pathname),
    size_bytes: metadata.sizeBytes,
  });
  return {
    filename: filenameFromPath(url.pathname),
    sizeBytes: metadata.sizeBytes,
    body: result.body,
    close: async () => {
      await result.body?.cancel().catch(() => undefined);
    },
  };
}

/**
 * 校验并打开一个可入站的文件源。只做解析与大小探测，不消费 body。
 * 调用方必须保证最终消费或调用 close()。
 */
export async function resolveIngestSource(
  rawUrl: string,
  config: AppConfig = loadConfig(),
): Promise<IngestSource> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiV1Error("invalid_request", "源 URL 无效。", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiV1Error("invalid_request", "源 URL 仅支持 HTTP/HTTPS。", 400);
  }
  const host = hostnameOf(url);
  const allowed = allowedHostnames(config);
  assertAllowedHost(url, allowed);
  auditLog("mcp_source_resolution_started", {
    source_url: safeUrl(url.toString()),
    source_host: host,
    source_kind: isSameBucketHost(host, config) ? "zos" : "http",
  });
  return isSameBucketHost(host, config)
    ? resolveSameBucketSource(url, config)
    : resolveHttpSource(url, config);
}
