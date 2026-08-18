import {
  parseJson,
  parseOptionalJson,
  parseUuid,
  withApiV1,
} from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { scopeFromRequest } from "@/server/api/v1/scope";
import { apiV1Path } from "@/lib/paths";
import {
  mutationContextSchema,
  updateAssetTaskSchema,
} from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ assetId: string }> };

export async function GET(request: Request, context: Context) {
  return withApiV1(request, async () => {
    const { assetId: rawAssetId } = await context.params;
    const asset = await getApiV1Service().getAsset(
      parseUuid(rawAssetId, "asset_id"),
      scopeFromRequest(request),
    );
    return Response.json(asset, {
      headers: { "cache-control": "no-store" },
    });
  });
}
export async function PATCH(request: Request, context: Context) {
  return withApiV1(request, async () => {
    const { assetId: rawAssetId } = await context.params;
    const input = await parseJson(request, updateAssetTaskSchema);
    const task = await getApiV1Service().updateAsset(
      parseUuid(rawAssetId, "asset_id"),
      input,
    );
    return Response.json(task, {
      status: 202,
      headers: {
        location: apiV1Path(`/tasks/${task.task_id}`),
        "cache-control": "no-store",
      },
    });
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApiV1(request, async () => {
    const { assetId: rawAssetId } = await context.params;
    const input = await parseOptionalJson(request, mutationContextSchema);
    const task = await getApiV1Service().deleteAsset(
      parseUuid(rawAssetId, "asset_id"),
      input,
    );
    return Response.json(task, {
      status: 202,
      headers: {
        location: apiV1Path(`/tasks/${task.task_id}`),
        "cache-control": "no-store",
      },
    });
  });
}
