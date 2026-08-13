import { parseJson, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { assetQuerySchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, assetQuerySchema);
    return Response.json(await getApiV1Service().searchAssets(input), {
      headers: { "cache-control": "no-store" },
    });
  });
}
