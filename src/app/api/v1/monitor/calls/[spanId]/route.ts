import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";
import { parseUuid, withApiV1 } from "@/server/api/handler";
import { callDetail } from "@/server/services/call-monitor";
import { taskLogQuerySchema } from "@/shared/monitor-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ spanId: string }> }) {
  const unauthorized = await ensureWebUiApiAuthorized(request);
  if (unauthorized) return unauthorized;
  return withApiV1(request, async () => {
    const id = parseUuid((await context.params).spanId, "span_id");
    const query = taskLogQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await callDetail(id, query.after, query.limit), { headers: { "cache-control": "no-store" } });
  });
}
