import { parseJson, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { storageUsageRequestSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const { user_id } = await parseJson(request, storageUsageRequestSchema);
    const result = await getApiV1Service().getStorageUsage(user_id);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
