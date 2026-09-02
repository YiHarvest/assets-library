import { apiV1Path } from "@/lib/paths";
import { parseJson, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";
import { compatibilityMatchRequestSchema } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicRequestOrigin(request: Request) {
  const fallback = new URL(request.url).origin;
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (!forwardedHost || !["http", "https"].includes(forwardedProtocol ?? "")) {
    return fallback;
  }
  try {
    return new URL(`${forwardedProtocol}://${forwardedHost}`).origin;
  } catch {
    return fallback;
  }
}

/** 兼容旧剪辑业务：异步对齐 ASR/LLM 分段、匹配素材并投递 camelCase 回调。 */
export async function POST(request: Request) {
  return withApiV1(request, async () => {
    const input = await parseJson(request, compatibilityMatchRequestSchema);
    const accepted = await getApiV1Service().createCompatibilityMatchTask(
      input,
      publicRequestOrigin(request),
    );
    return Response.json(accepted, {
      status: 202,
      headers: {
        location: apiV1Path(`/tasks/${accepted.taskId}`),
        "cache-control": "no-store",
      },
    });
  });
}
