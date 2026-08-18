import { ApiV1Error } from "@/server/api/errors";
import { apiV1ErrorResponse } from "@/server/api/handler";
import { assertSamePublicOrigin } from "@/server/api/request-origin";
import { loadConfig } from "@/server/config";

type FetchWithDuplex = RequestInit & { duplex?: "half" };

function assertSameOriginBrowserRequest(request: Request) {
  assertSamePublicOrigin(request, "不允许跨站调用 UI 代理。");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new ApiV1Error("forbidden", "不允许跨站调用 UI 代理。", 403);
  }
}

function proxyTarget(request: Request, segments: string[]) {
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw new ApiV1Error("invalid_request", "UI 代理路径无效。", 400);
  }
  const source = new URL(request.url);
  const config = loadConfig();
  const target = new URL(
    `/api/v1/${segments.map(encodeURIComponent).join("/")}`,
    `http://${config.PRD_INTERNAL_SERVICE_HOST}:${process.env.PORT || "23015"}`,
  );
  target.search = source.search;
  return target;
}

/**
 * 浏览器只访问同源代理。代理保留同源检查，但项目内部部署不再要求
 * API Key 或登录会话。
 */
export async function proxyUiApi(request: Request, segments: string[]) {
  try {
    assertSameOriginBrowserRequest(request);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cookie");
    headers.delete("connection");
    headers.delete("upgrade");
    headers.delete("keep-alive");
    headers.delete("proxy-connection");
    headers.delete("transfer-encoding");
    headers.delete("te");
    headers.delete("trailer");
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await fetch(proxyTarget(request, segments), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      cache: "no-store",
      ...(hasBody ? { duplex: "half" as const } : {}),
    } satisfies FetchWithDuplex);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return apiV1ErrorResponse(error);
  }
}
