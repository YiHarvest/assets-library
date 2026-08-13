import type { TaskAccepted, TaskStatusResponse } from "@/shared/contracts";

interface ApiFailure {
  error?: { message?: string };
}

export const UI_API_V1 = "/api/v1";

export function browserMediaUrl(url: string) {
  return url;
}

export async function uiApi<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${UI_API_V1}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(
      (payload as ApiFailure | null)?.error?.message ?? `操作失败（HTTP ${response.status}）。`,
    );
  }
  return payload as T;
}

export async function waitForTask(
  task: Pick<TaskAccepted, "task_id">,
  options: { signal?: AbortSignal; intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 1_000;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException("已停止轮询。", "AbortError");
    const status = await uiApi<TaskStatusResponse>(
      `/tasks?task_id=${encodeURIComponent(task.task_id)}`,
      {
        signal: options.signal,
      },
    );
    if (status.status === "done") return status;
    if (status.status === "failed") {
      throw new Error(status.error?.message ?? "后台任务执行失败。");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, intervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new DOMException("已停止轮询。", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
