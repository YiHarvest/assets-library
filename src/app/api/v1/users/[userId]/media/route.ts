import { parseUserIdPath, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { userMediaListQuerySchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  return withApiV1(request, async () => {
    const { userId } = await context.params;
    const url = new URL(request.url);
    const input = userMediaListQuerySchema.parse({
      project_id: url.searchParams.get("project_id") ?? undefined,
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const result = await getApiV1Service().listUserMedia(
      parseUserIdPath(userId),
      input,
      url.origin,
    );
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  });
}
