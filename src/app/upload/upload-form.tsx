"use client";

import Image from "next/image";
import Link from "next/link";
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
import { uiApi } from "@/lib/api-v1-client";
import type { TaskStatusResponse } from "@/shared/contracts";

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

function taskItemError(item: TaskStatusResponse["files"][number]) {
  if (!item.error) return "素材处理失败。";
  const segments = item.error.details
    ?.filter((detail) => detail.segment_index !== undefined)
    .map((detail) => {
      const size = detail.size_bytes
        ? `（${(detail.size_bytes / 1024 / 1024).toFixed(1)} MiB）`
        : "";
      return `切片 ${Number(detail.segment_index) + 1}${size}`;
    });
  return segments?.length
    ? `${item.error.message}：${segments.join("、")}`
    : item.error.message;
}

export function UploadForm({ initialUserId = "" }: { initialUserId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const pollControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [userId, setUserId] = useState(initialUserId);
  const [autoPublish, setAutoPublish] = useState(false);
  const [task, setTask] = useState<TaskStatusResponse | null>(null);
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

  const applyTask = (next: TaskStatusResponse) => {
    if (!mountedRef.current) return;
    setTask(next);
    setItems((current) =>
      current.map((item) => {
        const remote = next.files.find(
          (candidate) => candidate.item_id === item.serverItemId,
        );
        if (!remote) return item;
        const phase: UploadPhase =
          remote.status === "failed"
            ? "failed"
            : remote.status === "done"
              ? "completed"
              : item.phase === "uploading"
                ? "uploading"
                : "processing";
        return {
          ...item,
          phase,
          progress: remote.progress_percent,
          assetIds: remote.asset_ids,
          error: remote.status === "failed" ? taskItemError(remote) : "",
        };
      }),
    );
  };

  const poll = async (taskId: string) => {
    const controller = new AbortController();
    pollControllerRef.current = controller;
    try {
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, 1_000);
          controller.signal.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer);
              reject(new DOMException("Polling stopped.", "AbortError"));
            },
            { once: true },
          );
        });
        const next = await uiApi<TaskStatusResponse>(
          `/tasks?task_id=${encodeURIComponent(taskId)}`,
          {
            signal: controller.signal,
          },
        );
        applyTask(next);
        if (next.status === "done") return;
        if (next.status === "failed") {
          setError(next.error?.message ?? "任务中有素材处理失败，请查看明细。");
          return;
        }
      }
    } catch (cause) {
      if (
        mountedRef.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
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
      (videoItems.length === 0 && items.length > 5)
    ) {
      setError("每批只能上传一个视频，或最多五张图片，且不能混合上传。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const body = new FormData();
      body.set("user_id", userId);
      body.set("auto_publish", String(autoPublish));
      for (const item of items) body.append("files", item.file, item.file.name);
      setItems((current) =>
        current.map((item) => ({
          ...item,
          phase: "uploading",
          progress: 0,
          error: "",
        })),
      );
      const created = await uiApi<TaskStatusResponse>("/uploads", {
        method: "POST",
        body,
      });
      if (created.files.length !== items.length) {
        throw new Error("服务端返回的上传清单与所选文件不一致。");
      }
      setTask(created);
      setItems((current) =>
        current.map((item, index) => ({
          ...item,
          serverItemId: created.files[index]?.item_id ?? null,
          phase: "processing",
          progress: created.files[index]?.progress_percent ?? 100,
        })),
      );
      applyTask(created);
      void poll(created.task_id);
    } catch (cause) {
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
      (videos.length === 0 && combined.length > 5)
    ) {
      setError("每批只能选择一个视频，或最多五张图片，且不能混合上传。");
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
                JPEG / PNG / WebP ≤ 20 MB · MP4 视频将自动分镜
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
                          href={`/assets/${item.assetIds[0]}`}
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
                {Math.round(task.progress_percent)}%
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-cyan-500 transition-all"
                style={{ width: `${task.progress_percent}%` }}
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
          <p className="text-sm text-slate-500">
            {items.length === 0
              ? "一次可上传 1–5 张图片，或一个 MP4 视频，不能混合。"
              : failedCount > 0
                ? `${failedCount} 个素材上传或处理失败，请查看原因。${queuedCount > 0 ? ` 还有 ${queuedCount} 个素材等待上传。` : ""}`
                : completeCount === items.length && items.length > 0
                  ? "本次任务中的素材均已处理完成。"
                  : queuedCount > 0
                    ? `还有 ${queuedCount} 个素材等待上传。`
                    : "任务已提交，正在后台处理。"}
          </p>
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
