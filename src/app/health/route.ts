import { collectHealth } from "@/server/health/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 无鉴权健康探针；响应只包含组件状态，不暴露内部连接信息。 */
export async function GET() {
  const report = await collectHealth();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
