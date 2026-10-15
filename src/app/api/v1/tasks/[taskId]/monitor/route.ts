import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";
import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getMonitorDetail } from "@/server/services/task-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const unauthorized = await ensureWebUiApiAuthorized(request);
  if (unauthorized) return unauthorized;
  return withApiV1(request, async () => {
    const taskId = parseUuid((await context.params).taskId, "task_id");
    return Response.json(await getMonitorDetail(taskId), { headers: { "cache-control": "no-store" } });
  });
}
