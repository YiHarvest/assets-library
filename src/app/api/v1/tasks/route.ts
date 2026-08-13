import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 所有上传与变更任务均通过同一个静态地址轮询。 */
export async function GET(request: Request) {
  return withApiV1(request, async () => {
    const taskId = new URL(request.url).searchParams.get("task_id") ?? "";
    const result = await getApiV1Service().getTask(parseUuid(taskId, "task_id"));
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
