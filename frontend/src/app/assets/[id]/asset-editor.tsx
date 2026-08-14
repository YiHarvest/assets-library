"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  RefreshCcw,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { MediaPreview } from "@/components/media-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  browserMediaUrl,
  uiApi,
  waitForTask,
} from "@/lib/api-v1-client";
import { prefixedHref } from "@/lib/base-path";
import { groupDisplayTags } from "@/lib/asset-tags";
import { reportBrowserEvent } from "@/lib/browser-observability";
import {
  createOperationId,
  elapsedMilliseconds,
  type TelemetryMetadata,
} from "@/lib/observability-core";
import { withUserScope } from "@/lib/user-scope";
import type { AssetDetail, TaskAccepted } from "@/shared/contracts";

const statusLabel = {
  queued: "等待处理",
  running: "处理中",
  done: "分析完成",
  failed: "处理失败",
  pending_review: "等待入库",
};

function detailPath(asset: AssetDetail) {
  return `/assets/detail?file_id=${encodeURIComponent(asset.file_id)}`;
}

export function AssetEditor({
  initialAsset,
  viewerUserId,
}: {
  initialAsset: AssetDetail;
  viewerUserId: string;
}) {
  const router = useRouter();
  const [asset, setAsset] = useState(initialAsset);
  const [name, setName] = useState(initialAsset.file_name);
  const [description, setDescription] = useState(initialAsset.description);
  const [tagText, setTagText] = useState(
    initialAsset.tags.join("\n"),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const assetId = asset.file_id;
  const assetStatus = asset.status;
  const assetUserId = asset.user_id;
  const canEdit = Boolean(
    assetUserId && viewerUserId && assetUserId === viewerUserId,
  );

  useEffect(() => {
    if (!["queued", "running"].includes(assetStatus)) return;
    const path = `/assets/detail?file_id=${encodeURIComponent(assetId)}`;
    const timer = window.setInterval(async () => {
      try {
        const next = await uiApi<AssetDetail>(path, {
          action: "assets.detail.refresh",
          telemetryMetadata: { file_id: assetId },
        });
        setAsset(next);
        if (next.status === "done") {
          setDescription(next.description);
          setTagText(next.tags.join("\n"));
        }
      } catch {
        // Keep polling; transient network errors are shown only on explicit actions.
      }
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [assetId, assetStatus, assetUserId]);

  const parsedTags = useMemo(
    () =>
      tagText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 100),
    [tagText],
  );

  const run = async (
    actionName: string,
    metadata: TelemetryMetadata,
    action: (operationId: string) => Promise<void>,
  ) => {
    const operationId = createOperationId();
    const startedAt = performance.now();
    setBusy(true);
    setMessage("");
    void reportBrowserEvent({
      operationId,
      event: "user_action",
      step: actionName,
      status: "started",
      metadata: { ...metadata, action: actionName },
    });
    try {
      await action(operationId);
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: actionName,
        durationMs: elapsedMilliseconds(startedAt),
        status: "done",
        metadata: { ...metadata, action: actionName },
      });
    } catch (error) {
      void reportBrowserEvent({
        operationId,
        event: "user_action",
        step: actionName,
        durationMs: elapsedMilliseconds(startedAt),
        status: "failed",
        metadata: {
          ...metadata,
          action: actionName,
          error_type: error instanceof Error ? error.name : "unknown",
        },
      });
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run("asset.update", { file_id: asset.file_id, user_scope: "personal" }, async (operationId) => {
      const task = await uiApi<TaskAccepted>("/assets/update", {
        method: "PATCH",
        body: JSON.stringify({
          file_id: asset.file_id,
          user_id: asset.user_id,
          file_name: name,
          description,
          tags: parsedTags,
        }),
        operationId,
        action: "asset.update.request",
        telemetryMetadata: { file_id: asset.file_id, user_scope: "personal" },
      });
      await waitForTask(task, {
        operationId,
        action: "asset.update.poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: task.task_id },
      });
      const next = await uiApi<AssetDetail>(detailPath(asset), {
        operationId,
        action: "asset.update.result",
        telemetryMetadata: { file_id: asset.file_id },
      });
      setAsset(next);
      setMessage("更改已保存。");
      router.refresh();
    });

  const publish = () =>
    run("asset.publish", { file_id: asset.file_id, user_scope: asset.user_id ? "personal" : "public" }, async (operationId) => {
      const updateTask = await uiApi<TaskAccepted>("/assets/update", {
        method: "PATCH",
        body: JSON.stringify({
          file_id: asset.file_id,
          user_id: asset.user_id,
          file_name: name,
          description,
          tags: parsedTags,
        }),
        operationId,
        action: "asset.publish.update",
        telemetryMetadata: { file_id: asset.file_id },
      });
      await waitForTask(updateTask, {
        operationId,
        action: "asset.publish.update_poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: updateTask.task_id },
      });
      const publishTask = await uiApi<TaskAccepted>("/assets/publish", {
          method: "POST",
          body: JSON.stringify({
            file_id: asset.file_id,
            user_id: asset.user_id,
          }),
          operationId,
          action: "asset.publish.request",
          telemetryMetadata: { file_id: asset.file_id },
        });
      await waitForTask(publishTask, {
        operationId,
        action: "asset.publish.poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: publishTask.task_id },
      });
      const next = await uiApi<AssetDetail>(detailPath(asset), {
        operationId,
        action: "asset.publish.result",
        telemetryMetadata: { file_id: asset.file_id },
      });
      setAsset(next);
      setMessage("素材已正式入库。");
      router.refresh();
    });

  const retry = () =>
    run("asset.retry", { file_id: asset.file_id, user_scope: asset.user_id ? "personal" : "public" }, async (operationId) => {
      const task = await uiApi<TaskAccepted>("/assets/retry", {
          method: "POST",
          body: JSON.stringify({
            file_id: asset.file_id,
            user_id: asset.user_id,
          }),
          operationId,
          action: "asset.retry.request",
          telemetryMetadata: { file_id: asset.file_id },
        });
      await waitForTask(task, {
        operationId,
        action: "asset.retry.poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: task.task_id },
      });
      const next = await uiApi<AssetDetail>(detailPath(asset), {
        operationId,
        action: "asset.retry.result",
        telemetryMetadata: { file_id: asset.file_id },
      });
      setAsset(next);
      setMessage("已重新加入处理队列。");
    });

  const remove = () => {
    const confirmation = asset.user_id
      ? "移出个人素材库并转为公共素材"
      : "永久删除公共素材及其文件";
    if (!window.confirm(`确认${confirmation}？`)) return;
    return run("asset.delete", { file_id: asset.file_id, user_scope: asset.user_id ? "personal" : "public" }, async (operationId) => {
      const task = await uiApi<TaskAccepted>("/assets/delete", {
        method: "DELETE",
        body: JSON.stringify({
          file_id: asset.file_id,
          user_id: asset.user_id,
        }),
        operationId,
        action: "asset.delete.request",
        telemetryMetadata: { file_id: asset.file_id },
      });
      await waitForTask(task, {
        operationId,
        action: "asset.delete.poll",
        telemetryMetadata: { file_id: asset.file_id, task_id: task.task_id },
      });
      router.push(prefixedHref(withUserScope("/", viewerUserId)));
      router.refresh();
    });
  };

  return (
    <>
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge>{asset.media_type === "image" ? "图片" : "视频"}</Badge>
            <Badge
              className={
                asset.status === "failed"
                  ? "bg-red-100 text-red-700"
                  : asset.status === "done"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700"
              }
            >
              {statusLabel[asset.status]}
            </Badge>
            <Badge>
              {asset.phase === "published" ? "已入库" : "待审核"}
            </Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{asset.file_name}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {asset.file_name} · {(asset.size_bytes / 1024 / 1024).toFixed(1)} MB
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {asset.status === "failed" && (
            <Button variant="outline" disabled={busy} onClick={retry}>
              <RefreshCcw className="size-4" /> 重试
            </Button>
          )}
          <Button asChild variant="outline">
            <a
              href={`${browserMediaUrl(asset.media_url)}${asset.media_url.includes("?") ? "&" : "?"}download=1`}
              download={asset.file_name}
            >
              <Download className="size-4" /> 下载素材
            </a>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            <Trash2 className="size-4" /> 删除
          </Button>
        </div>
      </div>

      {asset.error && (
        <div className="mb-6 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-medium">{asset.error.message}</p>
            <p className="mt-1 font-mono text-xs">{asset.error.code}</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="aspect-video min-h-72 bg-slate-100">
              <MediaPreview
                mediaType={asset.media_type}
                src={browserMediaUrl(
                  asset.media_type === "image"
                    ? asset.cover_url
                    : asset.media_url,
                )}
                poster={browserMediaUrl(asset.cover_url)}
                name={asset.file_name}
              />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">分析结果</h2>
            </CardHeader>
            <CardContent>
              {asset.analysis ? (
                <AnalysisView
                  analysis={asset.analysis}
                  description={description}
                  tags={parsedTags}
                />
              ) : (
                <div className="flex items-center gap-3 py-8 text-sm text-slate-500">
                  {asset.status === "failed" ? (
                    <AlertCircle className="size-5" />
                  ) : (
                    <Clock3 className="size-5 animate-pulse" />
                  )}
                  {asset.status === "failed"
                    ? "暂无可用分析结果。"
                    : "后台正在分析素材，页面会自动更新。"}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <h2 className="text-lg font-semibold">素材信息</h2>
          </CardHeader>
          <CardContent className="space-y-5">
            <label className="block space-y-2">
              <span className="text-sm font-medium">素材名称</span>
              <Input
                value={name}
                disabled={!canEdit}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">描述</span>
              <Textarea
                rows={6}
                value={description}
                disabled={!canEdit}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">标签</span>
              <Textarea
                rows={9}
                value={tagText}
                disabled={!canEdit}
                onChange={(event) => setTagText(event.target.value)}
              />
            </label>
            {message && (
              <p className="flex items-center gap-2 text-sm text-slate-600">
                <CheckCircle2 className="size-4 text-emerald-600" /> {message}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={busy || !canEdit} onClick={save}>
                <Save className="size-4" /> 保存
              </Button>
              {asset.status === "pending_review" && (
                  <Button disabled={busy} onClick={publish}>
                    <Send className="size-4" /> 确认入库
                  </Button>
                )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function AnalysisView({
  analysis,
  description,
  tags,
}: {
  analysis: AssetDetail["analysis"];
  description: string;
  tags: string[];
}) {
  if (!analysis) return null;
  if ("ocr" in analysis) {
    const tagsByCategory = groupDisplayTags(tags);
    return (
      <div className="space-y-5 text-sm">
        <p className="leading-7 text-slate-700">{description}</p>
        {tagsByCategory.map(([category, values]) => (
          <div key={category}>
            <p className="mb-2 font-medium text-slate-500">{category}</p>
            <div className="flex flex-wrap gap-2">
              {values.map((tag, index) => (
                <Badge key={`${tag.raw}-${index}`}>{tag.value}</Badge>
              ))}
            </div>
          </div>
        ))}
        <div>
          <p className="mb-2 font-medium text-slate-500">OCR</p>
          <p className="whitespace-pre-wrap leading-6">
            {analysis.ocr.text ?? analysis.ocr.unavailable_reason ?? "无可识别文本"}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5 text-sm">
      <p className="leading-7 text-slate-700">{description}</p>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag, index) => <Badge key={`${tag}-${index}`}>{tag}</Badge>)}
      </div>
      <div>
        <p className="mb-2 font-medium text-slate-500">主题</p>
        <div className="flex flex-wrap gap-2">
          {analysis.topics.map((topic, index) => (
            <Badge key={`${topic}-${index}`}>{topic}</Badge>
          ))}
        </div>
      </div>
      <TimedSection
        title="视觉分段"
        items={analysis.visual_segments.map((segment) => ({
          time: `${formatSeconds(segment.start_seconds)}–${formatSeconds(segment.end_seconds)}`,
          summary: segment.summary,
        }))}
      />
      <TimedSection
        title="关键时间点"
        items={analysis.key_moments.map((moment) => ({
          time: formatSeconds(moment.seconds),
          summary: moment.summary,
        }))}
      />
      <TimedSection
        title="时间轴"
        items={analysis.timeline.map((entry) => ({
          time: `${formatSeconds(entry.start_seconds)}–${formatSeconds(entry.end_seconds)}`,
          summary: entry.summary,
        }))}
      />
    </div>
  );
}

function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes > 0
    ? `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`
    : `${remainder.toFixed(1)}s`;
}

function TimedSection({
  title,
  items,
}: {
  title: string;
  items: Array<{ time: string; summary: string }>;
}) {
  return (
    <div>
      <p className="mb-3 font-medium text-slate-500">{title}</p>
      {items.length > 0 ? (
        <ol className="space-y-3 border-l border-slate-200 pl-4">
          {items.map((item, index) => (
            <li key={`${item.time}-${item.summary}-${index}`}>
              <span className="font-mono text-xs text-cyan-700">{item.time}</span>
              <p className="mt-1">{item.summary}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-slate-400">模型未返回相关内容。</p>
      )}
    </div>
  );
}
