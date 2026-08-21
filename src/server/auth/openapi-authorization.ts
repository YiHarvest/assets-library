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

export async function ensureOpenApiAuthorized(request: Request) {
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
        message: "OpenAPI access requires WebUI authorization.",
      },
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": "Bearer realm=\"assets-library-openapi\"",
        vary: "authorization, cookie",
      },
    },
  );
}
