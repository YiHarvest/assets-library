import fs from "node:fs/promises";
import path from "node:path";
import { ensureOpenApiAuthorized } from "@/server/auth/openapi-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenAPI 是管理文档的数据源，需要页面会话或脚本 Bearer；其余 `/api/v1/**`
// 仍是对既有第三方调用方开放的兼容层，绝不能把这里的认证扩散到业务接口。
export async function GET(request: Request) {
  const authorizationFailure = await ensureOpenApiAuthorized(request);
  if (authorizationFailure) return authorizationFailure;

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
