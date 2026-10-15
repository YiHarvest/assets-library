import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";
import { withApiV1 } from "@/server/api/handler";
import { listCalls } from "@/server/services/call-monitor";
import { callQuerySchema } from "@/shared/call-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const unauthorized = await ensureWebUiApiAuthorized(request);
  if (unauthorized) return unauthorized;
  return withApiV1(request, async () => Response.json(
    await listCalls(callQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams))),
    { headers: { "cache-control": "no-store" } },
  ));
}
