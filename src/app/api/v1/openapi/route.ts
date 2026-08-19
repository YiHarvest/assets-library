import fs from "node:fs/promises";
import path from "node:path";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenAPI 是管理文档的数据源，需要页面会话或脚本 Bearer；其余 `/api/v1/**`
// 仍是对既有第三方调用方开放的兼容层，绝不能把这里的认证扩散到业务接口。
export async function GET(request: Request) {
  let lock;
  try {
    lock = readWebUiLockConfig();
  } catch {
    return new Response("WebUI lock configuration is invalid.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  if (lock.enabled && lock.key) {
    const bearer = readBearerCredential(request.headers.get("authorization"));
    const session = readCookie(
      request.headers.get("cookie"),
      WEBUI_LOCK_COOKIE_NAME,
    );
    const authorized =
      webUiLockKeyMatches(bearer, lock.key) ||
      (await verifyWebUiSession(session, lock.key));
    if (!authorized) {
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
  }

  const specification = await fs.readFile(
    path.join(process.cwd(), "spec/contracts/openapi.yaml"),
    "utf8",
  );
  return new Response(specification, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "no-store",
      vary: "authorization, cookie",
    },
  });
}
