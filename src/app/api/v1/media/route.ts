import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiV1(request, () => {
    const assetId = new URL(request.url).searchParams.get("asset_id") ?? "";
    return getApiV1Service().getMedia(parseUuid(assetId, "asset_id"), request);
  });
}
