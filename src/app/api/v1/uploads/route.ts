import { withApiV1, parseJson } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { createUploadTaskSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, createUploadTaskSchema);
    const task = await getApiV1Service().createUploadTask(input);
    return Response.json(task, {
      status: 201,
      headers: {
        location: `/api/v1/tasks/${task.task_id}`,
        "cache-control": "no-store",
      },
    });
  });
}
