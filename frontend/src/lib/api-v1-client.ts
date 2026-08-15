import { PUBLIC_BASE_PATH } from "@/lib/base-path";
import { apiFailureMessage, decodeApiResponse } from "@/lib/api-response";
import { reportBrowserEvent } from "@/lib/browser-observability";
import {
  createOperationId,
  elapsedMilliseconds,
  safeEndpoint,
  type TelemetryMetadata,
} from "@/lib/observability-core";
import type { TaskAccepted, TaskResponse } from "@/shared/contracts";

export const UI_API_V1 = `${PUBLIC_BASE_PATH}/api/v1`;

export function browserMediaUrl(url: string) {
  if (!url.startsWith("/")) return url;
  return `${PUBLIC_BASE_PATH}${url}`;
}

/** 后台标签页暂停轮询；恢复可见时立即继续，不等待原定时器。 */
export function waitForPollingWindow(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: number | undefined;
    const cleanup = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("已停止轮询。", "AbortError"));
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined) {
        finish();
      }
    };
    if (signal?.aborted) return onAbort();
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!document.hidden) timer = window.setTimeout(finish, delayMs);
  });
}

export interface UiApiOptions extends RequestInit {
  operationId?: string;
  action?: string;
  telemetryMetadata?: TelemetryMetadata;
}

export async function uiApi<T>(path: string, options: UiApiOptions = {}) {
  const {
    operationId = createOperationId(),
    action = "api.request",
    telemetryMetadata,
    ...init
  } = options;
  const method = (init.method ?? "GET").toUpperCase();
  const endpoint = safeEndpoint(path);
  const startedAt = performance.now();
  let failureReported = false;
  void reportBrowserEvent({
    operationId,
    event: "api_request",
    step: action,
    status: "started",
    metadata: { ...telemetryMetadata, endpoint, method, action },
  });
  try {
    const response = await fetch(`${UI_API_V1}${path}`, {
      ...init,
      headers: {
        ...(init.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
        ...init.headers,
        "x-operation-id": operationId,
      },
      cache: "no-store",
    });
    const { payload, invalidJson } = await decodeApiResponse(response);
    if (!response.ok) {
      void reportBrowserEvent({
        operationId,
        event: "api_request",
        step: action,
        durationMs: elapsedMilliseconds(startedAt),
        status: "failed",
        metadata: {
          ...telemetryMetadata,
          endpoint,
          method,
          action,
          status_code: response.status,
        },
      });
      failureReported = true;
      throw new Error(apiFailureMessage(payload, response.status, invalidJson));
    }
    if (invalidJson) {
      throw new Error(`后端返回了无法识别的数据（HTTP ${response.status}）。`);
    }
    void reportBrowserEvent({
      operationId,
      event: "api_request",
      step: action,
      durationMs: elapsedMilliseconds(startedAt),
      status: "done",
      metadata: {
        ...telemetryMetadata,
        endpoint,
        method,
        action,
        status_code: response.status,
      },
    });
    return payload as T;
  } catch (error) {
    if (!failureReported) {
      void reportBrowserEvent({
        operationId,
        event: "api_request",
        step: action,
        durationMs: elapsedMilliseconds(startedAt),
        status: "failed",
        metadata: {
          ...telemetryMetadata,
          endpoint,
          method,
          action,
          error_type: error instanceof Error ? error.name : "unknown",
        },
      });
    }
    throw error;
  }
}

export async function waitForTask(
  task: Pick<TaskAccepted, "task_id">,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    operationId?: string;
    action?: string;
    telemetryMetadata?: TelemetryMetadata;
  } = {},
) {
  const operationId = options.operationId ?? createOperationId();
  const action = options.action ?? "task.poll";
  const startedAt = Date.now();
  let previous: Pick<TaskResponse, "status" | "phase"> | null = null;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException("已停止轮询。", "AbortError");
    const status = await uiApi<TaskResponse>(
      `/tasks?task_id=${encodeURIComponent(task.task_id)}`,
      {
        signal: options.signal,
        operationId,
        action: `${action}.request`,
        telemetryMetadata: options.telemetryMetadata,
      },
    );
    if (nextStatusChanged(previous, status)) {
      void reportBrowserEvent({
        operationId,
        event: "task_poll",
        step: `${action}.phase_changed`,
        status: "done",
        metadata: {
          ...options.telemetryMetadata,
          task_id: status.task_id,
          previous_status: previous?.status,
          previous_phase: previous?.phase,
          status: status.status,
          phase: status.phase,
        },
      });
      previous = { status: status.status, phase: status.phase };
    }
    if (status.status === "done" || status.status === "pending_review") return status;
    if (status.status === "failed") {
      throw new Error(status.error?.message ?? "后台任务执行失败。");
    }
    const elapsed = Date.now() - startedAt;
    const intervalMs = options.intervalMs ?? (elapsed < 30_000 ? 5_000 : elapsed < 120_000 ? 10_000 : 30_000);
    await waitForPollingWindow(intervalMs, options.signal);
  }
}

function nextStatusChanged(
  previous: Pick<TaskResponse, "status" | "phase"> | null,
  current: Pick<TaskResponse, "status" | "phase">,
) {
  return !previous || previous.status !== current.status || previous.phase !== current.phase;
}
