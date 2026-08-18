import { ApiV1Error } from "@/server/api/errors";
import { parseUuid, withApiV1 } from "@/server/api/handler";
import { getApiV1Service } from "@/server/api/v1/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ taskId: string; itemId: string }> },
) {
  return withApiV1(request, async () => {
    const { taskId: rawTaskId, itemId: rawItemId } = await context.params;
    const taskId = parseUuid(rawTaskId, "task_id");
    const itemId = parseUuid(rawItemId, "item_id");
    if (!request.body) {
      throw new ApiV1Error("invalid_request", "上传内容不能为空。", 400);
    }
    const rawLength = request.headers.get("content-length");
    const contentLength = rawLength === null ? null : Number(rawLength);
    if (
      contentLength !== null &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0)
    ) {
      throw new ApiV1Error(
        "invalid_request",
        "Content-Length 必须是非负整数。",
        400,
      );
    }
    const task = await getApiV1Service().receiveUploadItem({
      taskId,
      itemId,
      body: request.body,
      contentLength,
      contentType: request.headers.get("content-type"),
    });
    return Response.json(task, {
      status: 202,
      headers: {
        location: `/api/v1/tasks/${task.task_id}`,
        "cache-control": "no-store",
      },
    });
  });
}
