import { parseJson, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { assetActionSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, assetActionSchema);
    const task = await getApiV1Service().actOnAsset(input);
    return Response.json(task, {
      status: 202,
      headers: {
        location: `/api/v1/tasks?task_id=${encodeURIComponent(task.task_id)}`,
        "cache-control": "no-store",
      },
    });
  });
}
