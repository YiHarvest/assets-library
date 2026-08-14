"use client";

import { BaseLink as Link } from "@/components/base-link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { MediaPreview } from "@/components/media-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { browserMediaUrl, uiApi, waitForTask } from "@/lib/api-v1-client";
import { reportBrowserEvent } from "@/lib/browser-observability";
import { createOperationId, elapsedMilliseconds } from "@/lib/observability-core";
import type {
  ApiTaskStatus,
  AssetSummary,
  TaskAccepted,
} from "@/shared/contracts";

const statusLabel: Record<ApiTaskStatus, string> = {
  queued: "等待处理",
  running: "处理中",
  done: "分析完成",
  failed: "处理失败",
  pending_review: "等待入库",
};

function detailHref(asset: AssetSummary, viewerUserId: string) {
  const query = viewerUserId
    ? `?user_id=${encodeURIComponent(viewerUserId)}`
    : "";
  return `/assets/${asset.file_id}${query}`;
}

function previewSource(asset: AssetSummary) {
  return asset.media_type === "image" ? asset.cover_url : asset.media_url;
}

export function AssetOverviewGrid({
  assets,
  layout,
  viewerUserId,
}: {
  assets: AssetSummary[];
  layout: "gallery" | "list";
  viewerUserId: string;
}) {
  const router = useRouter();
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const hasActiveJobs = assets.some((asset) =>
    ["queued", "running"].includes(asset.status),
  );
  const hasSearchScores = assets.some(
    (asset) => asset.similarity_score !== undefined,
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const refreshVisiblePage = () => {
      if (!document.hidden) router.refresh();
    };
    const timer = window.setInterval(refreshVisiblePage, 2_000);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [hasActiveJobs, router]);

  useEffect(() => {
    if (previewIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewIndex(null);
      if (event.key === "ArrowLeft") {
        setPreviewIndex((index) =>
          index === null ? null : Math.max(0, index - 1),
        );
      }
      if (event.key === "ArrowRight") {
        setPreviewIndex((index) =>
          index === null ? null : Math.min(assets.length - 1, index + 1),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assets.length, previewIndex]);

  const publish = async (asset: AssetSummary) => {
    const operationId = createOperationId();
    const startedAt = performance.now();
    setPublishingId(asset.file_id);
    setMessage("");
    void reportBrowserEvent({
      operationId,
      event: "user_action",
      step: "asset.publish",
      status: "started",
      metadata: {
        action: "asset.publish",
        file_id: asset.file_id,
        user_scope: asset.user_id ? "personal" : "public",
      },
    });
    try {
      const task = await uiApi<TaskAccepted>("/assets/publish", {
        method: "POST",
        body: JSON.stringify({
          file_id: asset.file_id,
          user_id: asset.user_id,
        }),
        operationId,
        action: "asset.publish.request",
        telemetryMetadata: { file_id: asset.file_id },
      });
      await waitForTask(task, {
        operationId,
        action: "asset.publish.poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: task.task_id },
      });
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "asset.publish",
        durationMs: elapsedMilliseconds(startedAt),
        status: "done",
        metadata: { action: "asset.publish", file_id: asset.file_id },
      });
      router.refresh();
    } catch (cause) {
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "asset.publish",
        durationMs: elapsedMilliseconds(startedAt),
        status: "failed",
        metadata: {
          action: "asset.publish",
          file_id: asset.file_id,
          error_type: cause instanceof Error ? cause.name : "unknown",
        },
      });
      setMessage(cause instanceof Error ? cause.message : "入库失败。");
    } finally {
      setPublishingId(null);
    }
  };

  const retry = async (asset: AssetSummary) => {
    const operationId = createOperationId();
    const startedAt = performance.now();
    setRetryingId(asset.file_id);
    setMessage("");
    void reportBrowserEvent({
      operationId,
      event: "user_action",
      step: "asset.retry",
      status: "started",
      metadata: {
        action: "asset.retry",
        file_id: asset.file_id,
        video_source_id: asset.video_source_id,
      },
    });
    try {
      const task = await uiApi<TaskAccepted>("/assets/retry", {
        method: "POST",
        body: JSON.stringify(
          asset.video_source_id
            ? {
                video_source_id: asset.video_source_id,
                user_id: asset.user_id,
              }
            : { file_id: asset.file_id, user_id: asset.user_id },
        ),
        operationId,
        action: "asset.retry.request",
        telemetryMetadata: {
          file_id: asset.file_id,
          video_source_id: asset.video_source_id,
        },
      });
      await waitForTask(task, {
        operationId,
        action: "asset.retry.poll",
        telemetryMetadata: { task_id: task.task_id },
      });
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "asset.retry",
        durationMs: elapsedMilliseconds(startedAt),
        status: "done",
        metadata: { action: "asset.retry", task_id: task.task_id },
      });
      router.refresh();
    } catch (cause) {
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "asset.retry",
        durationMs: elapsedMilliseconds(startedAt),
        status: "failed",
        metadata: {
          action: "asset.retry",
          file_id: asset.file_id,
          error_type: cause instanceof Error ? cause.name : "unknown",
        },
      });
      setMessage(cause instanceof Error ? cause.message : "重试失败。");
    } finally {
      setRetryingId(null);
    }
  };

  const remove = async (asset: AssetSummary) => {
    if (!window.confirm(`确认删除失败素材“${asset.file_name}”？临时文件也会被清理。`)) return;
    const operationId = createOperationId();
    const startedAt = performance.now();
    setDeletingId(asset.file_id);
    setMessage("");
    try {
      const task = await uiApi<TaskAccepted>("/assets/delete", {
        method: "DELETE",
        body: JSON.stringify(
          asset.video_source_id
            ? { video_source_id: asset.video_source_id, user_id: asset.user_id }
            : { file_id: asset.file_id, user_id: asset.user_id },
        ),
        operationId,
        action: "asset.delete_failed.request",
        telemetryMetadata: {
          file_id: asset.file_id,
          video_source_id: asset.video_source_id,
        },
      });
      await waitForTask(task, {
        operationId,
        action: "asset.delete_failed.poll",
        telemetryMetadata: { task_id: task.task_id },
      });
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: "asset.delete_failed",
        durationMs: elapsedMilliseconds(startedAt),
        status: "done",
        metadata: { action: "asset.delete_failed", file_id: asset.file_id },
      });
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "删除失败。");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {message && (
        <p className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="size-4" /> {message}
        </p>
      )}
      {hasSearchScores && (
        <div className="flex items-center justify-between rounded-2xl bg-white/55 px-4 py-3 text-sm text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
          <span>搜索结果按相关性排序</span>
          <button
            type="button"
            className="font-medium text-[#0071e3] transition-opacity hover:opacity-70 dark:text-blue-400"
            onClick={() => setShowDiagnostics((visible) => !visible)}
            aria-pressed={showDiagnostics}
          >
            {showDiagnostics ? "隐藏检索诊断" : "显示检索诊断"}
          </button>
        </div>
      )}
      {layout === "gallery" ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {assets.map((asset, index) => (
            <GalleryCard
              key={asset.file_id}
              asset={asset}
              showDiagnostics={showDiagnostics}
              publishing={publishingId === asset.file_id}
              retrying={retryingId === asset.file_id}
              deleting={deletingId === asset.file_id}
              onPreview={() => setPreviewIndex(index)}
              onPublish={publish}
              onRetry={retry}
              onDelete={remove}
              viewerUserId={viewerUserId}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[1.5rem] border border-black/[0.06] bg-white/90 shadow-sm dark:border-white/[0.10] dark:bg-[#1c1c1e]">
          {assets.map((asset, index) => (
            <ListRow
              key={asset.file_id}
              asset={asset}
              showDiagnostics={showDiagnostics}
              publishing={publishingId === asset.file_id}
              retrying={retryingId === asset.file_id}
              deleting={deletingId === asset.file_id}
              onPreview={() => setPreviewIndex(index)}
              onPublish={publish}
              onRetry={retry}
              onDelete={remove}
              viewerUserId={viewerUserId}
            />
          ))}
        </div>
      )}
      {previewIndex !== null && (
        <PreviewDialog
          asset={assets[previewIndex]!}
          current={previewIndex}
          total={assets.length}
          viewerUserId={viewerUserId}
          onClose={() => setPreviewIndex(null)}
          onPrevious={() =>
            setPreviewIndex((index) => Math.max(0, (index ?? 0) - 1))
          }
          onNext={() =>
            setPreviewIndex((index) =>
              Math.min(assets.length - 1, (index ?? 0) + 1),
            )
          }
        />
      )}
    </div>
  );
}

function AssetStatus({ asset }: { asset: AssetSummary }) {
  const tone =
    asset.status === "failed"
      ? "text-red-700"
      : asset.status === "done"
        ? "text-emerald-700"
        : "text-amber-700";
  const Icon =
    asset.status === "failed"
      ? AlertCircle
      : asset.status === "done"
        ? CheckCircle2
        : Clock3;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <Icon className="size-3" /> {statusLabel[asset.status]}
    </span>
  );
}

function AssetTags({ asset }: { asset: AssetSummary }) {
  return (
    <div className="flex min-h-6 flex-wrap gap-1.5">
      {asset.tags.slice(0, 3).map((tag, index) => (
        <Badge key={`${tag}-${index}`}>{tag}</Badge>
      ))}
    </div>
  );
}

function Diagnostics({ asset }: { asset: AssetSummary }) {
  if (asset.similarity_score === undefined) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-black/[0.06] pt-3 text-xs text-slate-500 dark:border-white/[0.10] dark:text-slate-400">
      <span>语义分：{asset.similarity_score.toFixed(3)}</span>
    </div>
  );
}

interface AssetCardProps {
  asset: AssetSummary;
  showDiagnostics: boolean;
  publishing: boolean;
  retrying: boolean;
  deleting: boolean;
  onPreview: () => void;
  onPublish: (asset: AssetSummary) => Promise<void>;
  onRetry: (asset: AssetSummary) => Promise<void>;
  onDelete: (asset: AssetSummary) => Promise<void>;
  viewerUserId: string;
}

function GalleryCard({
  asset,
  showDiagnostics,
  publishing,
  retrying,
  deleting,
  onPreview,
  onPublish,
  onRetry,
  onDelete,
  viewerUserId,
}: AssetCardProps) {
  const canPublish = asset.status === "pending_review";
  const canRetry = asset.status === "failed";
  return (
    <Card className="group h-full overflow-hidden bg-white/90 transition-[box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:shadow-[0_14px_34px_rgba(0,0,0,0.10)] dark:bg-[#1c1c1e] dark:hover:shadow-black/40 motion-reduce:transition-none">
      <button
        type="button"
        className="relative block w-full text-left"
        onClick={onPreview}
        aria-label={`预览 ${asset.file_name}`}
      >
        <div className="aspect-[4/3] overflow-hidden bg-[#e9e9eb]">
          <MediaPreview
            mediaType={asset.media_type}
            src={browserMediaUrl(previewSource(asset))}
            poster={browserMediaUrl(asset.cover_url)}
            name={asset.file_name}
            className="transition-transform duration-500 ease-out group-hover:scale-[1.025] motion-reduce:transition-none"
          />
        </div>
        <span className="absolute right-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
          {asset.media_type === "image" ? "图片" : "视频"}
        </span>
      </button>
      <CardContent className="space-y-3 p-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          {asset.phase === "published" ? (
            <Link
              href={detailHref(asset, viewerUserId)}
              className="truncate font-semibold tracking-tight hover:text-[#0071e3]"
            >
              {asset.file_name}
            </Link>
          ) : (
            <span className="truncate font-semibold tracking-tight">{asset.file_name}</span>
          )}
          <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
            {asset.phase === "published" ? "已入库" : "待审核"}
          </span>
        </div>
        <AssetStatus asset={asset} />
        <AssetTags asset={asset} />
        {showDiagnostics && <Diagnostics asset={asset} />}
      </CardContent>
      {canPublish && (
        <CardContent className="pt-0">
          <Button
            className="w-full"
            size="sm"
            disabled={publishing}
            onClick={() => void onPublish(asset)}
          >
            <Send className="size-3.5" />
            {publishing ? "正在入库…" : "确认入库"}
          </Button>
        </CardContent>
      )}
      {canRetry && (
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={retrying || deleting}
              onClick={() => void onRetry(asset)}
            >
              <RotateCcw className="size-3.5" />
              {retrying ? "正在重试…" : "重试"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={retrying || deleting}
              onClick={() => void onDelete(asset)}
            >
              <Trash2 className="size-3.5" />
              {deleting ? "正在删除…" : "删除"}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function ListRow({
  asset,
  showDiagnostics,
  publishing,
  retrying,
  deleting,
  onPreview,
  onPublish,
  onRetry,
  onDelete,
  viewerUserId,
}: AssetCardProps) {
  const canPublish = asset.status === "pending_review";
  const canRetry = asset.status === "failed";
  return (
    <article className="flex gap-4 border-b border-black/[0.06] p-3 last:border-0 dark:border-white/[0.10] sm:items-center sm:p-4">
      <button
        type="button"
        className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-[#e9e9eb] sm:size-24"
        onClick={onPreview}
        aria-label={`预览 ${asset.file_name}`}
      >
        <MediaPreview
          mediaType={asset.media_type}
          src={browserMediaUrl(previewSource(asset))}
          poster={browserMediaUrl(asset.cover_url)}
          name={asset.file_name}
        />
      </button>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-3">
          {asset.phase === "published" ? (
            <Link
              href={detailHref(asset, viewerUserId)}
              className="truncate font-semibold tracking-tight hover:text-[#0071e3]"
            >
              {asset.file_name}
            </Link>
          ) : (
            <span className="truncate font-semibold tracking-tight">{asset.file_name}</span>
          )}
          <span className="hidden shrink-0 text-xs text-slate-400 dark:text-slate-500 sm:inline">
            {asset.media_type === "image" ? "图片" : "视频"}
          </span>
        </div>
        <p className="line-clamp-1 text-sm text-slate-500 dark:text-slate-400">
          {asset.description || "暂无描述"}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AssetStatus asset={asset} /> <AssetTags asset={asset} />
        </div>
        {showDiagnostics && <Diagnostics asset={asset} />}
      </div>
      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPreview}
          aria-label={`预览 ${asset.file_name}`}
        >
          <Eye className="size-3.5" />
        </Button>
        {canPublish && (
          <Button
            size="sm"
            disabled={publishing}
            onClick={() => void onPublish(asset)}
          >
            {publishing ? "正在入库…" : "入库"}
          </Button>
        )}
        {canRetry && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={retrying || deleting}
              onClick={() => void onRetry(asset)}
            >
              <RotateCcw className="size-3.5" />
              {retrying ? "重试中…" : "重试"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={retrying || deleting}
              onClick={() => void onDelete(asset)}
            >
              <Trash2 className="size-3.5" />
              {deleting ? "删除中…" : "删除"}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function PreviewDialog({
  asset,
  current,
  total,
  viewerUserId,
  onClose,
  onPrevious,
  onNext,
}: {
  asset: AssetSummary;
  current: number;
  total: number;
  viewerUserId: string;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={`${asset.file_name} 预览`}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="关闭预览"
        onClick={onClose}
      />
      <div className="relative flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-[1.75rem] bg-[#1d1d1f] shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 text-white">
          <div className="min-w-0">
            <p className="truncate font-medium">{asset.file_name}</p>
            <p className="mt-0.5 text-xs text-white/60">
              {current + 1} / {total}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {asset.phase === "published" && (
              <Link
                href={detailHref(asset, viewerUserId)}
                className="rounded-full bg-white/15 px-3 py-2 text-sm hover:bg-white/25"
              >
                查看详情
              </Link>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={onClose}
              aria-label="关闭预览"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 bg-black">
          <MediaPreview
            mediaType={asset.media_type}
            src={browserMediaUrl(previewSource(asset))}
            poster={browserMediaUrl(asset.cover_url)}
            name={asset.file_name}
            className="object-contain"
          />
          <button
            type="button"
            className="absolute left-4 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-30"
            onClick={onPrevious}
            disabled={current === 0}
            aria-label="上一个素材"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            className="absolute right-4 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-30"
            onClick={onNext}
            disabled={current === total - 1}
            aria-label="下一个素材"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
        <div className="border-t border-white/10 px-5 py-4 text-sm text-white/70">
          <div className="flex flex-wrap gap-2">
            {asset.tags.map((tag, index) => (
              <span
                key={`${tag}-${index}`}
                className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/85"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
