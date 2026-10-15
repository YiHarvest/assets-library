import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";
import { withApiV1 } from "@/server/api/handler";
import { listMonitorTasks } from "@/server/services/task-monitor";
import { monitorQuerySchema } from "@/shared/monitor-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = await ensureWebUiApiAuthorized(request);
  if (unauthorized) return unauthorized;
  return withApiV1(request, async () => Response.json(
    await listMonitorTasks(monitorQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams))),
    { headers: { "cache-control": "no-store" } },
  ));
}
