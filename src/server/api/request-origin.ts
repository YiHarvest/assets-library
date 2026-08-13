import { ApiV1Error } from "@/server/api/errors";

function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || null;
}

export function publicRequestOrigin(request: Request) {
  const internalUrl = new URL(request.url);
  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const host = forwardedHost ?? firstHeaderValue(request.headers.get("host"));
  if (!host) return internalUrl.origin;

  const forwardedProtocol = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );
  const protocol = forwardedProtocol ?? internalUrl.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") return internalUrl.origin;

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return internalUrl.origin;
  }
}

/**
 * 按浏览器实际访问的公开 Host 校验 Origin。
 *
 * Next.js 在反向代理或不同监听地址后面可能把 request.url 生成为 localhost，
 * 因此不能直接拿它与浏览器 Origin 比较。代理头由受信任的同机反向代理设置；
 * 没有代理头时使用原始 Host。
 */
export function assertSamePublicOrigin(request: Request, message: string) {
  const received = request.headers.get("origin");
  if (!received) return;

  let receivedOrigin: string;
  try {
    receivedOrigin = new URL(received).origin;
  } catch {
    throw new ApiV1Error("forbidden", message, 403);
  }
  if (receivedOrigin !== publicRequestOrigin(request)) {
    throw new ApiV1Error("forbidden", message, 403);
  }
}
