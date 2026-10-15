import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";
import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getTaskLogs } from "@/server/services/task-monitor";
import { taskLogQuerySchema } from "@/shared/monitor-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const unauthorized = await ensureWebUiApiAuthorized(request);
  if (unauthorized) return unauthorized;
  return withApiV1(request, async () => {
    const taskId = parseUuid((await context.params).taskId, "task_id");
    const query = taskLogQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await getTaskLogs(taskId, query), { headers: { "cache-control": "no-store" } });
  });
}
