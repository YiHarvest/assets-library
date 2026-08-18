import {
  parseOptionalJson,
  parseUuid,
  withApiV1,
} from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { mutationContextSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  return withApiV1(request, async () => {
    const { assetId: rawAssetId } = await context.params;
    const input = await parseOptionalJson(request, mutationContextSchema);
    const task = await getApiV1Service().publishAsset(
      parseUuid(rawAssetId, "asset_id"),
      input,
    );
    return Response.json(task, {
      status: 202,
      headers: {
        location: `/api/v1/tasks/${task.task_id}`,
        "cache-control": "no-store",
      },
    });
  });
}
