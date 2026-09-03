import type {
  ApiTaskPhase,
  ApiTaskStatus,
  ApiV1ErrorCode,
  TaskAccepted,
  TaskStatusResponse,
} from "@/shared/contracts";
import { apiV1ErrorCodeSchema } from "@/shared/contracts";
import { ApiV1Error } from "@/server/api/errors";

export interface TaskRepository {
  getTaskWithItems(taskId: string): Promise<{
    task: {
      id: string;
      userId: string | null;
      type: string;
      status: string;
      phase: string;
      progressPercent: number;
      receivedBytes: number;
      totalBytes: number;
      totalItems: number;
      doneItems: number;
      failedItems: number;
      callbackUrl: string | null;
      result: Record<string, unknown> | null;
      errorCode: string | null;
      errorMessage: string | null;
      errorDetails: unknown;
      createdAt: Date;
      startedAt: Date | null;
      finishedAt: Date | null;
      expiresAt: Date | null;
    };
    items: Array<{
      id: string;
      filename: string;
      mediaType: "image" | "video" | null;
      status: string;
      phase: string;
      receivedBytes: number;
      totalBytes: number;
      errorCode: string | null;
      errorMessage: string | null;
      errorDetails: unknown;
    }>;
  }>;
  listTaskItemAssetIds(taskId: string): Promise<
    Array<{
      id: string;
      taskItemId: string | null;
      kind: "public" | "private";
      segmentIndex: number | null;
    }>
  >;
  listUserTaskIds(
    userId: string,
    options: {
      statuses?: Array<"queued" | "running" | "done" | "failed">;
      types?: Array<
        "upload" | "delete" | "publish" | "update" | "retry" | "match"
      >;
      before?: { createdAt: Date; id: string };
      limit: number;
    },
  ): Promise<Array<{ id: string; createdAt: Date }>>;
}

export interface ListTasksInput {
  cursor?: string | null;
  limit: number;
  statuses?: Array<"queued" | "running" | "done" | "failed">;
  types?: Array<
    "upload" | "delete" | "publish" | "update" | "retry" | "match"
  >;
}

export interface TaskListResponse {
  items: TaskStatusResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

function encodeListCursor(createdAt: Date, id: string) {
  return Buffer.from(
    JSON.stringify({ created_at: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeListCursor(cursor?: string | null) {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { created_at?: unknown; id?: unknown };
    const createdAt = new Date(String(value.created_at));
    if (
      typeof value.created_at === "string" &&
      !Number.isNaN(createdAt.getTime()) &&
      typeof value.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(value.id)
    ) {
      return { createdAt, id: value.id };
    }
  } catch {
    // 统一成公开错误。
  }
  throw new ApiV1Error("invalid_request", "cursor 无效或已经过期。", 400);
}

function shanghaiIso(value: Date | null) {
  if (!value) return null;
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

function apiStatus(status: string): ApiTaskStatus {
  if (status === "done" || status === "failed" || status === "running") {
    return status;
  }
  return "queued";
}

function apiPhase(phase: string, status: string): ApiTaskPhase {
  const phases = new Set<ApiTaskPhase>([
    "receiving",
    "waiting_for_seal",
    "validating",
    "splitting",
    "persisting",
    "analyzing",
    "publishing",
    "updating",
    "retrying",
    "deleting",
    "matching",
    "notifying",
    "finished",
  ]);
  if (phases.has(phase as ApiTaskPhase)) return phase as ApiTaskPhase;
  if (status === "done" || status === "failed") return "finished";
  if (phase === "sealed") return "validating";
  if (phase === "received") return "waiting_for_seal";
  return "receiving";
}

function publicErrorCode(code: string | null): ApiV1ErrorCode {
  const mapped: Partial<Record<string, ApiV1ErrorCode>> = {
    scene_service_unavailable: "service_unavailable",
    scene_manifest_invalid: "scene_detection_failed",
    scene_segment_download_failed: "scene_detection_failed",
    scene_segment_invalid: "scene_detection_failed",
    scene_segment_too_large: "segment_too_large",
    scene_persistence_failed: "storage_error",
    multiple_files: "invalid_request",
  };
  const normalized = mapped[code ?? ""];
  if (normalized) return normalized;
  const parsed = apiV1ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "internal_error";
}

function detailList(value: unknown) {
  const snakeCase = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(snakeCase);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, child]) => [
        key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
        snakeCase(child),
      ]),
    );
  };

  if (Array.isArray(value)) return snakeCase(value) as unknown[];
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const segments = Array.isArray(record.segments) ? record.segments : null;
  if (!segments) return [snakeCase(record)];
  return segments.map((segment) => {
    if (!segment || typeof segment !== "object") return { value: segment };
    const source = segment as Record<string, unknown>;
    const normalized = snakeCase(source) as Record<string, unknown>;
    const sizeBytes = source.actualBytes ?? source.sizeBytes;
    const limitBytes = source.maximumBytes ?? source.limitBytes;
    delete normalized.actual_bytes;
    delete normalized.maximum_bytes;
    if (sizeBytes !== undefined) normalized.size_bytes = sizeBytes;
    if (limitBytes !== undefined) normalized.limit_bytes = limitBytes;
    return normalized;
  });
}

export function apiTaskErrorPayload(row: {
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: unknown;
}) {
  if (!row.errorCode && !row.errorMessage) return null;
  const details = detailList(row.errorDetails);
  return {
    code: publicErrorCode(row.errorCode),
    message: row.errorMessage ?? "任务处理失败。",
    ...(details ? { details } : {}),
  } as NonNullable<TaskStatusResponse["error"]>;
}

function progress(received: number, total: number) {
  return total > 0 ? Math.min(100, (received / total) * 100) : 0;
}

export function acceptedTask(response: TaskStatusResponse): TaskAccepted {
  return {
    task_id: response.task_id,
    task_type: response.task_type,
    status: response.status,
    phase: response.phase,
    progress_percent: response.progress_percent,
    total_items: response.total_items,
    items: response.items,
    created_at: response.created_at,
  };
}

export class TaskService {
  constructor(private readonly repository: TaskRepository) {}

  async getTask(
    taskId: string,
    expectedUserId?: string,
  ): Promise<TaskStatusResponse> {
    const { task, items } = await this.repository.getTaskWithItems(taskId);
    if (expectedUserId !== undefined && task.userId !== expectedUserId) {
      // 与“不存在”使用相同响应，避免向其他 MCP 用户泄露任务是否存在。
      throw new ApiV1Error("not_found", "任务不存在。", 404);
    }
    const assetRows = items.length
      ? await this.repository.listTaskItemAssetIds(taskId)
      : [];
    const privateAssetsByItem = new Map<string, string[]>();
    const publicAssetsByItem = new Map<string, string[]>();
    for (const asset of assetRows) {
      if (!asset.taskItemId) continue;
      const target =
        asset.kind === "private" ? privateAssetsByItem : publicAssetsByItem;
      const current = target.get(asset.taskItemId) ?? [];
      current.push(asset.id);
      target.set(asset.taskItemId, current);
    }
    return {
      task_id: task.id,
      task_type: task.type as TaskStatusResponse["task_type"],
      status: apiStatus(task.status),
      phase: apiPhase(task.phase, task.status),
      progress_percent: task.progressPercent,
      received_bytes: task.receivedBytes,
      total_bytes: task.totalBytes,
      total_items: task.totalItems,
      done_items: task.doneItems,
      failed_items: task.failedItems,
      callback_url: task.callbackUrl,
      result: task.result,
      items: items.map((item) => ({
        item_id: item.id,
        filename: item.filename,
        media_type: item.mediaType,
        status: apiStatus(item.status),
        phase: apiPhase(item.phase, item.status),
        received_bytes: item.receivedBytes,
        total_bytes: item.totalBytes,
        progress_percent:
          item.status === "done"
            ? 100
            : progress(item.receivedBytes, item.totalBytes),
        private_asset_ids: privateAssetsByItem.get(item.id) ?? [],
        public_asset_ids: publicAssetsByItem.get(item.id) ?? [],
        error: apiTaskErrorPayload(item),
      })),
      error: apiTaskErrorPayload(task),
      created_at: shanghaiIso(task.createdAt)!,
      started_at: shanghaiIso(task.startedAt),
      finished_at: shanghaiIso(task.finishedAt),
      expires_at: shanghaiIso(task.expiresAt),
    };
  }

  async getAcceptedTask(taskId: string) {
    return acceptedTask(await this.getTask(taskId));
  }

  async listTasks(
    userId: string,
    input: ListTasksInput,
  ): Promise<TaskListResponse> {
    const before = decodeListCursor(input.cursor);
    const rows = await this.repository.listUserTaskIds(userId, {
      statuses: input.statuses,
      types: input.types,
      before,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      items: await Promise.all(page.map(({ id }) => this.getTask(id, userId))),
      next_cursor:
        hasMore && page.at(-1)
          ? encodeListCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
          : null,
      has_more: hasMore,
    };
  }
}
