const secretKey = /authorization|cookie|password|passwd|secret|token|api[_-]?key|signature|credential/i;

/** 只记录结构化业务数据；递归移除密钥和 URL 中的凭据。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[depth limit]";
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(redact(JSON.parse(value), depth + 1)); } catch { /* 普通日志文本。 */ }
    }
    return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        if (url.username) url.username = "REDACTED";
        if (url.password) url.password = "REDACTED";
        for (const key of [...url.searchParams.keys()]) {
          if (secretKey.test(key)) url.searchParams.set(key, "REDACTED");
        }
        return url.toString();
      } catch { return match; }
    }).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, secretKey.test(key) ? "[REDACTED]" : redact(child, depth + 1),
    ]));
  }
  return value;
}

/** 限制记录体积；媒体字节流、循环引用和类实例不直接序列化。 */
export function snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (item == null) return null;
    if (typeof item === "string") {
      const clean = String(redact(item));
      return clean.length > 8192 ? `${clean.slice(0, 8192)}…[truncated]` : clean;
    }
    if (typeof item === "number" || typeof item === "boolean") return item;
    if (typeof item === "bigint") return item.toString();
    if (typeof item !== "object") return `[${typeof item}]`;
    if (depth > 8) return "[depth limit]";
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (item instanceof Date) return item.toISOString();
    if (item instanceof Map) return visit(Array.from(item.entries()), depth + 1);
    if (item instanceof Set) return visit(Array.from(item.values()), depth + 1);
    if (item instanceof Error) return visit({ name: item.name, message: item.message, code: (item as Error & { code?: string }).code, stack: item.stack }, depth + 1);
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return { binary: true, byte_length: item.byteLength };
    if (item instanceof ReadableStream) return { streamed: true };
    if (item instanceof Request) return { method: item.method, url: item.url };
    if (item instanceof Response) return { status: item.status, content_type: item.headers.get("content-type"), streamed: true };
    if (Array.isArray(item)) return [...item.slice(0, 100).map((child) => visit(child, depth + 1)), ...(item.length > 100 ? [`[${item.length - 100} more items]`] : [])];
    return Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, child]) => [key, secretKey.test(key) ? "[REDACTED]" : visit(child, depth + 1)]));
  }
  try {
    const result = redact(visit(value, 0));
    const serialized = JSON.stringify(result);
    return Buffer.byteLength(serialized) > 65536
      ? { truncated: true, preview: serialized.slice(0, 12000) }
      : result;
  } catch { return "[unable to serialize]"; }
}

export async function responseSnapshot(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") || !response.body) return { status_code: response.status, content_type: contentType, content_length: response.headers.get("content-length"), streamed: Boolean(response.body) };
  const reader = response.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return snapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        size += value.byteLength;
        if (size > 65536) return { truncated: true, content_type: contentType };
        chunks.push(value);
      }
    };
    return await Promise.race([read(), new Promise((resolve) => { timeout = setTimeout(() => resolve({ truncated: true, reason: "capture_timeout" }), 1000); })]);
  } catch { return { unavailable: true, content_type: contentType }; }
  finally { clearTimeout(timeout); void reader.cancel().catch(() => undefined); }
}
