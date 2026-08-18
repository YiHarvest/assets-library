import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { apiV1Path } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  return withApiV1(request, async () => {
    const { taskId: rawTaskId } = await context.params;
    const taskId = parseUuid(rawTaskId, "task_id");
    const task = await getApiV1Service().sealUploadTask(taskId);
    return Response.json(task, {
      status: 202,
      headers: {
        location: apiV1Path(`/tasks/${task.task_id}`),
        "cache-control": "no-store",
      },
    });
  });
}
