import { parseJson, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { assetQuerySchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, assetQuerySchema);
    return Response.json(await getApiV1Service().queryAssets(input, {
      // REST/WebUI 的公共 AI 搜索按业务要求跨用户召回；MCP 不走此开关，
      // 继续严格遵守 own/public/all 的授权边界。
      expandPublicBroadAi: true,
    }), {
      headers: { "cache-control": "no-store" },
    });
  });
}
