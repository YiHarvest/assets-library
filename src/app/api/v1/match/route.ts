import { parseJson, withApiV1 } from "@/server/api/handler";
import { createMatchTask } from "@/server/services/match";
import { matchRequestSchema } from "@/shared/monitor-contracts";
import { apiV1Path } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const task = await createMatchTask(await parseJson(request, matchRequestSchema));
    return Response.json(task, {
      status: 202,
      headers: { location: apiV1Path(`/tasks/${task.task_id}`), "cache-control": "no-store" },
    });
  });
}
