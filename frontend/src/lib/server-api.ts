import "server-only";
import {
  createOperationId,
  elapsedMilliseconds,
  safeEndpoint,
  type TelemetryMetadata,
} from "@/lib/observability-core";
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  friendlyServerApiError,
} from "@/lib/api-errors";
import { reportServerEvent } from "@/lib/server-observability";

interface ApiFailure {
  error?: { message?: string };
}

function backendApiBase() {
  const origin = process.env.BACKEND_URL?.trim() || "http://127.0.0.1:23017";
  return `${origin.replace(/\/+$/, "")}/api/v1`;
}

export interface ServerApiOptions extends RequestInit {
  operationId?: string;
  action?: string;
  telemetryMetadata?: TelemetryMetadata;
}

export async function serverApi<T>(path: string, options: ServerApiOptions = {}) {
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
  const timeoutSignal = AbortSignal.timeout(BACKEND_REQUEST_TIMEOUT_MS);
  void reportServerEvent({
    operationId,
    event: "api_request",
    step: action,
    status: "started",
    metadata: { ...telemetryMetadata, endpoint, method, action },
  });
  try {
    // Server Component 不能在 backend 异常时无限等待，否则浏览器看到的就是
    // 一直加载。保留调用方 signal，并额外施加内部 API 总超时。
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(`${backendApiBase()}${path}`, {
      ...init,
      signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
        "x-operation-id": operationId,
      },
      cache: "no-store",
    });
    const payload = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      void reportServerEvent({
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
      throw new Error(
        (payload as ApiFailure | null)?.error?.message ??
          `后端请求失败（HTTP ${response.status}）。`,
      );
    }
    void reportServerEvent({
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
      void reportServerEvent({
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
    throw friendlyServerApiError(error, timeoutSignal.aborted);
  }
}
