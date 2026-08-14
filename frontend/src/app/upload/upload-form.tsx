"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { BaseLink as Link } from "@/components/base-link";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileVideo2,
  ImageIcon,
  LoaderCircle,
  Plus,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { uiApi, waitForPollingWindow } from "@/lib/api-v1-client";
import { prefixedHref } from "@/lib/base-path";
import { reportBrowserEvent } from "@/lib/browser-observability";
import { createOperationId, elapsedMilliseconds } from "@/lib/observability-core";
import { withUserScope } from "@/lib/user-scope";
import type {
  CreateUploadResponse,
  TaskFile,
  TaskResponse,
} from "@/shared/contracts";

type UploadPhase =
  | "queued"
  | "uploading"
  | "processing"
  | "completed"
  | "failed";

interface UploadItem {
  id: string;
  serverItemId: string | null;
  file: File;
  previewUrl: string;
  phase: UploadPhase;
  progress: number;
  assetIds: string[];
  error: string;
}

function localId() {
  return globalThis.crypto.randomUUID();
}

const phaseLabels: Record<UploadPhase, string> = {
  queued: "等待上传",
  uploading: "正在上传",
  processing: "正在处理",
  completed: "处理完成",
  failed: "上传或处理失败",
};

function isVideo(file: File) {
  return file.name.toLocaleLowerCase().endsWith(".mp4");
}

function taskItemError(item: TaskFile) {
  return item.error?.message ?? "素材处理失败。";
}

function taskProgress(task: TaskResponse) {
  if (task.total_files === 0) return 0;
  if (["done", "pending_review", "failed"].includes(task.status)) return 100;
  const completed = task.done_files + task.failed_files;
  return Math.min(95, Math.round((completed / task.total_files) * 100));
}

export function UploadForm({ initialUserId = "" }: { initialUserId?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const pollControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [userId, setUserId] = useState(initialUserId);
  const [autoPublish, setAutoPublish] = useState(false);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const previewUrls = previewUrlsRef.current;
    return () => {
      mountedRef.current = false;
      pollControllerRef.current?.abort();
      for (const previewUrl of previewUrls) URL.revokeObjectURL(previewUrl);
      previewUrls.clear();
    };
  }, []);

  const applyTask = (next: TaskResponse) => {
    if (!mountedRef.current) return;
    setTask(next);
    setItems((current) =>
      current.map((item, index) => {
        const remote = next.files.find(
          (candidate) =>
            candidate.file_id === item.serverItemId ||
            candidate.video_source_id === item.serverItemId,
        ) ?? next.files[index];
        if (!remote) return item;
        const phase: UploadPhase =
          remote.status === "failed"
            ? "failed"
            : remote.status === "done" || remote.status === "pending_review"
              ? "completed"
              : item.phase === "uploading"
                ? "uploading"
                : "processing";
        return {
          ...item,
          phase,
          progress:
            remote.status === "done" || remote.status === "pending_review"
              ? 100
              : remote.status === "running"
                ? 65
                : 30,
          assetIds:
            remote.phase === "published"
              ? remote.slices
                  ?.map((slice) => slice.file_id)
                  .filter((fileId): fileId is string => Boolean(fileId)) ??
                (remote.file_id ? [remote.file_id] : [])
              : [],
          error: remote.status === "failed" ? taskItemError(remote) : "",
        };
      }),
    );
  };

  const poll = async (
    taskId: string,
    operationId: string,
    operationStartedAt: number,
    initialTask: TaskResponse,
  ) => {
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let previous = { status: initialTask.status, phase: initialTask.phase };
    try {
      const startedAt = Date.now();
      for (;;) {
        const elapsed = Date.now() - startedAt;
        const delay = elapsed < 30_000 ? 5_000 : elapsed < 120_000 ? 10_000 : 30_000;
        await waitForPollingWindow(delay, controller.signal);
        const next = await uiApi<TaskResponse>(
          `/tasks?task_id=${encodeURIComponent(taskId)}`,
          {
            signal: controller.signal,
            operationId,
            action: "upload.poll.request",
            telemetryMetadata: { task_id: taskId },
          },
        );
        if (next.status !== previous.status || next.phase !== previous.phase) {
          void reportBrowserEvent({
            operationId,
            event: "task_poll",
            step: "upload.poll.phase_changed",
            status: "done",
            metadata: {
              task_id: taskId,
              previous_status: previous.status,
              previous_phase: previous.phase,
              status: next.status,
              phase: next.phase,
            },
          });
          previous = { status: next.status, phase: next.phase };
        }
        applyTask(next);
        if (next.status === "done" || next.status === "pending_review") {
          void reportBrowserEvent({
            operationId,
            event: "user_action",
            step: "upload",
            durationMs: elapsedMilliseconds(operationStartedAt),
            status: "done",
            metadata: { task_id: taskId, status: next.status, phase: next.phase },
          });
          return;
        }
        if (next.status === "failed") {
          void reportBrowserEvent({
            operationId,
            event: "user_action",
            step: "upload",
            durationMs: elapsedMilliseconds(operationStartedAt),
            status: "failed",
            metadata: { task_id: taskId, status: next.status, phase: next.phase },
          });
          setError(next.error?.message ?? "任务中有素材处理失败，请查看明细。");
          return;
        }
      }
    } catch (cause) {
      if (
        mountedRef.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
        void reportBrowserEvent({
          operationId,
          event: "user_action",
          step: "upload",
          durationMs: elapsedMilliseconds(operationStartedAt),
          status: "failed",
          metadata: {
            task_id: taskId,
            error_type: cause instanceof Error ? cause.name : "unknown",
          },
        });
        setError(cause instanceof Error ? cause.message : "无法获取任务状态。");
      }
    } finally {
      if (pollControllerRef.current === controller) {
        pollControllerRef.current = null;
      }
    }
  };

  const upload = async () => {
    const queuedItems = items.filter((item) => item.phase === "queued");
    if (queuedItems.length === 0) return;
    const videoItems = items.filter((item) => isVideo(item.file));
    if (
      (videoItems.length > 0 && items.length !== 1) ||
      (videoItems.length === 0 && items.length > 9)
    ) {
      setError("每批只能上传一个视频，或最多九张图片，且不能混合上传。");
      return;
    }
    const operationId = createOperationId();
    const operationStartedAt = performance.now();
    const mediaType = videoItems.length ? "video" : "image";
    const scopedUserId = userId.trim();
    router.replace(prefixedHref(withUserScope("/upload", scopedUserId)));
    setSubmitting(true);
    setError("");
    void reportBrowserEvent({
      operationId,
      event: "user_action",
      step: "upload",
      status: "started",
      metadata: {
        action: "upload",
        file_count: items.length,
        media_type: mediaType,
        auto_publish: autoPublish,
        user_scope: userId.trim() ? "personal" : "public",
      },
    });
    try {
      setItems((current) =>
        current.map((item) => ({
          ...item,
          phase: "uploading",
          progress: 0,
          error: "",
        })),
      );
      const createStartedAt = performance.now();
      void reportBrowserEvent({
        operationId,
        event: "upload",
        step: "create",
        status: "started",
        metadata: { file_count: items.length, media_type: mediaType },
      });
      let created: CreateUploadResponse;
      try {
        created = await uiApi<CreateUploadResponse>("/uploads", {
          method: "POST",
          body: JSON.stringify({
            user_id: userId.trim() || null,
            auto_publish: autoPublish,
            files: items.map((item) => ({
              media_type: isVideo(item.file) ? "video" : "image",
              file_name: item.file.name,
            })),
          }),
          operationId,
          action: "upload.create",
          telemetryMetadata: {
            file_count: items.length,
            media_type: mediaType,
            auto_publish: autoPublish,
            user_scope: userId.trim() ? "personal" : "public",
          },
        });
      } catch (cause) {
        void reportBrowserEvent({
          operationId,
          event: "upload",
          step: "create",
          durationMs: elapsedMilliseconds(createStartedAt),
          status: "failed",
          metadata: { error_type: cause instanceof Error ? cause.name : "unknown" },
        });
        throw cause;
      }
      void reportBrowserEvent({
        operationId,
        event: "upload",
        step: "create",
        durationMs: elapsedMilliseconds(createStartedAt),
        status: "done",
        metadata: {
          task_id: created.task_id,
          file_count: created.files.length,
          media_type: mediaType,
        },
      });
      if (created.files.length !== items.length) {
        throw new Error("服务端返回的上传清单与所选文件不一致。");
      }
      setItems((current) =>
        current.map((item, index) => ({
          ...item,
          serverItemId:
            created.files[index]?.file_id ??
            created.files[index]?.video_source_id ??
            null,
          progress: 10,
        })),
      );
      await Promise.allSettled(
        created.files.map(async (target, index) => {
          const file = items[index]?.file;
          if (!file) throw new Error("上传清单缺少本地文件。");
          const putStartedAt = performance.now();
          const identity = {
            task_id: created.task_id,
            file_id: target.file_id,
            video_source_id: target.video_source_id,
            file_position: index + 1,
            file_count: items.length,
            media_type: isVideo(file) ? "video" : "image",
          } as const;
          void reportBrowserEvent({
            operationId,
            event: "upload",
            step: "put",
            status: "started",
            metadata: { ...identity, progress_percent: 0 },
          });
          try {
            const response = await fetch(target.upload_url, {
              method: "PUT",
              body: file,
            });
            if (!response.ok) {
              void reportBrowserEvent({
                operationId,
                event: "upload",
                step: "put",
                durationMs: elapsedMilliseconds(putStartedAt),
                status: "failed",
                metadata: {
                  ...identity,
                  progress_percent: 0,
                  status_code: response.status,
                },
              });
              throw new Error(`直传对象存储失败（HTTP ${response.status}）。`);
            }
            void reportBrowserEvent({
              operationId,
              event: "upload",
              step: "put",
              durationMs: elapsedMilliseconds(putStartedAt),
              status: "done",
              metadata: { ...identity, progress_percent: 100, status_code: response.status },
            });
          } catch (cause) {
            if (!(cause instanceof Error && cause.message.startsWith("直传对象存储失败"))) {
              void reportBrowserEvent({
                operationId,
                event: "upload",
                step: "put",
                durationMs: elapsedMilliseconds(putStartedAt),
                status: "failed",
                metadata: {
                  ...identity,
                  progress_percent: 0,
                  error_type: cause instanceof Error ? cause.name : "unknown",
                },
              });
            }
            throw cause;
          }
        }),
      );
      setItems((current) =>
        current.map((item) => ({ ...item, phase: "processing", progress: 30 })),
      );
      const completeStartedAt = performance.now();
      void reportBrowserEvent({
        operationId,
        event: "upload",
        step: "complete",
        status: "started",
        metadata: { task_id: created.task_id, file_count: items.length },
      });
      let completed: TaskResponse;
      try {
        completed = await uiApi<TaskResponse>("/uploads/complete", {
          method: "POST",
          body: JSON.stringify({ task_id: created.task_id }),
          operationId,
          action: "upload.complete",
          telemetryMetadata: { task_id: created.task_id, file_count: items.length },
        });
      } catch (cause) {
        void reportBrowserEvent({
          operationId,
          event: "upload",
          step: "complete",
          durationMs: elapsedMilliseconds(completeStartedAt),
          status: "failed",
          metadata: {
            task_id: created.task_id,
            error_type: cause instanceof Error ? cause.name : "unknown",
          },
        });
        throw cause;
      }
      void reportBrowserEvent({
        operationId,
        event: "upload",
        step: "complete",
        durationMs: elapsedMilliseconds(completeStartedAt),
        status: completed.status === "failed" ? "failed" : "done",
        metadata: {
          task_id: created.task_id,
          status: completed.status,
          phase: completed.phase,
        },
      });
      applyTask(completed);
      if (!["done", "pending_review", "failed"].includes(completed.status)) {
        void poll(created.task_id, operationId, operationStartedAt, completed);
      } else {
        void reportBrowserEvent({
          operationId,
          event: "user_action",
          step: "upload",
          durationMs: elapsedMilliseconds(operationStartedAt),
          status: completed.status === "failed" ? "failed" : "done",
          metadata: {
            task_id: created.task_id,
            status: completed.status,
            phase: completed.phase,
          },
        });
      }
    } catch (cause) {
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "upload",
        durationMs: elapsedMilliseconds(operationStartedAt),
        status: "failed",
        metadata: { error_type: cause instanceof Error ? cause.name : "unknown" },
      });
      const message = cause instanceof Error ? cause.message : "上传任务创建失败。";
      setError(message);
      setItems((current) =>
        current.map((item) =>
          item.phase === "uploading"
            ? { ...item, phase: "failed", error: message }
            : item,
        ),
      );
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const choose = (selected: File[]) => {
    if (selected.length === 0) return;
    const combined = [...items.map((item) => item.file), ...selected];
    const videos = combined.filter(isVideo);
    if (
      (videos.length > 0 && combined.length !== 1) ||
      (videos.length === 0 && combined.length > 9)
    ) {
      setError("每批只能选择一个视频，或最多九张图片，且不能混合上传。");
      return;
    }
    const additions = selected.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.add(previewUrl);
      return {
        id: localId(),
        serverItemId: null,
        file,
        previewUrl,
        phase: "queued",
        progress: 0,
        assetIds: [],
        error: "",
      } satisfies UploadItem;
    });
    setItems((current) => [...current, ...additions]);
    setError("");
  };

  const removeItem = (item: UploadItem) => {
    if (item.phase !== "queued") return;
    URL.revokeObjectURL(item.previewUrl);
    previewUrlsRef.current.delete(item.previewUrl);
    setItems((current) =>
      current.filter((currentItem) => currentItem.id !== item.id),
    );
  };

  const queuedCount = items.filter((item) => item.phase === "queued").length;
  const failedCount = items.filter((item) => item.phase === "failed").length;
  const completeCount = items.filter(
    (item) => item.phase === "completed",
  ).length;

  return (
    <Card>
      <CardHeader>
        <div
          data-testid="upload-dropzone"
          className="flex h-64 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/70 p-4 text-center transition hover:border-cyan-400 hover:bg-cyan-50/40"
          onClick={() => {
            if (!submitting && !task) inputRef.current?.click();
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (submitting || task) {
              setError("当前批次已经创建，请新建下一批上传任务。");
              return;
            }
            choose(Array.from(event.dataTransfer.files));
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            disabled={submitting || Boolean(task)}
            accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4"
            onChange={(event) => {
              choose(Array.from(event.target.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          {items.length === 0 ? (
            <>
              <span className="mb-5 grid size-16 place-items-center rounded-2xl bg-white text-cyan-700 shadow-sm">
                <UploadCloud className="size-8" />
              </span>
              <h2 className="text-lg font-semibold">
                拖放一个或多个文件到这里，或点击选择
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                JPG / JPEG / PNG / WebP ≤ 20 MiB · MP4 视频将自动分镜
              </p>
            </>
          ) : (
            <div
              className="flex h-full min-h-0 w-full cursor-default flex-col text-left"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-2 pb-3">
                <p className="text-sm font-medium">已选择 {items.length} 个素材</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting || Boolean(task)}
                  onClick={() => inputRef.current?.click()}
                >
                  <Plus className="size-4" />
                  继续添加
                </Button>
              </div>
              <ul
                aria-label="上传素材列表"
                className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain py-3 pr-1"
              >
                {items.map((item) => (
                  <li
                    key={item.id}
                    tabIndex={0}
                    className="group rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none transition hover:border-cyan-300 focus:border-cyan-400"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.file.name}
                      </span>
                      <span
                        className={`shrink-0 text-xs ${
                          item.phase === "failed"
                            ? "font-medium text-red-600"
                            : "text-slate-500"
                        }`}
                      >
                        {phaseLabels[item.phase]}
                      </span>
                      {item.phase === "queued" && !task && (
                        <button
                          type="button"
                          aria-label={`移除 ${item.file.name}`}
                          className="hidden shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 group-hover:block group-focus:block"
                          onClick={() => removeItem(item)}
                        >
                          <X className="size-4" />
                        </button>
                      )}
                    </div>
                    {item.error && (
                      <p
                        role="alert"
                        className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700"
                      >
                        <XCircle className="mt-0.5 size-3.5 shrink-0" />
                        {item.error}
                      </p>
                    )}
                    <div
                      aria-label={`${item.file.name} 预览`}
                      className="mt-2 hidden border-t border-slate-100 pt-2 group-hover:block group-focus-within:block"
                    >
                      <div className="relative h-28 overflow-hidden rounded-lg bg-slate-950">
                        {isVideo(item.file) ? (
                          <video
                            src={item.previewUrl}
                            controls
                            muted
                            preload="metadata"
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <Image
                            src={item.previewUrl}
                            alt={`${item.file.name} 预览`}
                            fill
                            unoptimized
                            className="object-contain"
                          />
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                        {isVideo(item.file) ? (
                          <FileVideo2 className="size-3.5 shrink-0" />
                        ) : (
                          <ImageIcon className="size-3.5 shrink-0" />
                        )}
                        {(item.file.size / 1024 / 1024).toFixed(1)} MB
                      </div>
                      {(item.phase === "uploading" ||
                        item.phase === "processing") && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-cyan-500 transition-all"
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                      )}
                      {item.assetIds[0] && (
                        <Link
                          href={withUserScope(`/assets/${item.assetIds[0]}`, userId)}
                          className="mt-2 inline-flex text-xs font-medium text-cyan-700 hover:underline"
                        >
                          {item.assetIds.length > 1
                            ? `查看 ${item.assetIds.length} 个分镜素材`
                            : "查看素材详情"}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <label className="block space-y-2">
          <span className="text-sm font-medium">用户 ID（留空上传到公共素材库）</span>
          <Input
            value={userId}
            maxLength={191}
            disabled={submitting || Boolean(task)}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="例如 user-123"
          />
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4">
          <input
            type="checkbox"
            checked={autoPublish}
            disabled={submitting || Boolean(task)}
            onChange={(event) => setAutoPublish(event.target.checked)}
            className="mt-0.5 size-4 accent-cyan-600"
          />
          <span>
            <span className="block text-sm font-medium">分析完成后直接入库</span>
            <span className="mt-1 block text-xs text-slate-500">
              视频完成分镜和持久化后，各子视频会独立分析并入库。
            </span>
          </span>
        </label>

        {task && (
          <div className="rounded-xl border border-slate-200 p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span>任务总进度</span>
              <span className="font-mono tabular-nums">
                {taskProgress(task)}%
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-cyan-500 transition-all"
                style={{ width: `${taskProgress(task)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {task.done_files}/{task.total_files} 完成 · {task.failed_files} 失败 · task_id: {task.task_id}
            </p>
          </div>
        )}

        {error && (
          <p className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <XCircle className="size-4 shrink-0" /> {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          {!error && (
            <p className="text-sm text-slate-500">
              {items.length === 0
                ? "一次可上传 1–9 张图片，或一个 MP4 视频，不能混合。"
                : failedCount > 0
                  ? `${failedCount} 个素材上传或处理失败，请查看原因。${queuedCount > 0 ? ` 还有 ${queuedCount} 个素材等待上传。` : ""}`
                  : completeCount === items.length && items.length > 0
                    ? "本次任务中的素材均已处理完成。"
                    : queuedCount > 0
                      ? `还有 ${queuedCount} 个素材等待上传。`
                      : "任务已提交，正在后台处理。"}
            </p>
          )}
          <Button
            disabled={queuedCount === 0 || submitting || Boolean(task)}
            onClick={() => void upload()}
          >
            {submitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                正在上传…
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4" />
                开始上传
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
