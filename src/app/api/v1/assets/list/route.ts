import { parseJson, withApiV1 } from "@/server/api/handler";
import { publicRequestOrigin } from "@/server/api/request-origin";
import { getApiV1Service } from "@/server/api/v1/service";
import { assetListSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, assetListSchema);
    const result = await getApiV1Service().listAssets(
      input,
      publicRequestOrigin(request),
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
