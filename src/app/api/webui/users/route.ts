import { withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { ensureWebUiApiAuthorized } from "@/server/auth/openapi-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiV1(request, async () => {
    const authorizationFailure = await ensureWebUiApiAuthorized(request);
    if (authorizationFailure) return authorizationFailure;

    return Response.json(
      { items: await getApiV1Service().listUsers() },
      {
        headers: {
          "cache-control": "private, no-store",
          vary: "authorization, cookie",
        },
      },
    );
  });
}
