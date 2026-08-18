import { withApiV1, parseJson } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { createUploadTaskSchema } from "@/shared/contracts";
import { apiV1Path } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, createUploadTaskSchema);
    const task = await getApiV1Service().createUploadTask(input);
    return Response.json(task, {
      status: 201,
      headers: {
        location: apiV1Path(`/tasks/${task.task_id}`),
        "cache-control": "no-store",
      },
    });
  });
}
