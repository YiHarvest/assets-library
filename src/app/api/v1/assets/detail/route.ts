import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiV1(request, async () => {
    const assetId = new URL(request.url).searchParams.get("asset_id") ?? "";
    const result = await getApiV1Service().getAsset(
      parseUuid(assetId, "asset_id"),
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
