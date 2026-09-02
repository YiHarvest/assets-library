import {
  readCookie,
  readWebUiLockConfig,
  verifyWebUiSession,
  WEBUI_LOCK_COOKIE_NAME,
} from "@/server/auth/webui-lock";
import {
  readBearerCredential,
  webUiLockKeyMatches,
} from "@/server/auth/webui-lock-node";

async function ensureWebUiAuthorized(
  request: Request,
  realm: string,
  message: string,
) {
  let lock;
  try {
    lock = readWebUiLockConfig();
  } catch {
    return new Response("WebUI lock configuration is invalid.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!lock.enabled || !lock.key) return null;

  const bearer = readBearerCredential(request.headers.get("authorization"));
  const session = readCookie(
    request.headers.get("cookie"),
    WEBUI_LOCK_COOKIE_NAME,
  );
  if (
    webUiLockKeyMatches(bearer, lock.key) ||
    (await verifyWebUiSession(session, lock.key))
  ) {
    return null;
  }
  return Response.json(
    {
      error: {
        code: "unauthorized",
        message,
      },
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer realm="${realm}"`,
        vary: "authorization, cookie",
      },
    },
  );
}

export function ensureOpenApiAuthorized(request: Request) {
  return ensureWebUiAuthorized(
    request,
    "assets-library-openapi",
    "OpenAPI access requires WebUI authorization.",
  );
}

/** WebUI 管理接口必须复用页面锁，不能落入公开业务 API 的兼容边界。 */
export function ensureWebUiApiAuthorized(request: Request) {
  return ensureWebUiAuthorized(
    request,
    "assets-library-webui",
    "WebUI management access requires authorization.",
  );
}
