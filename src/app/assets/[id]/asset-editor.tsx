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
import { appUrl } from "@/lib/paths";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  browserMediaUrl,
  uiApi,
  waitForTask,
} from "@/lib/api-v1-client";
import type { ApiV1AssetDetail, TaskAccepted } from "@/shared/contracts";

const statusLabel = {
  queued: "等待处理",
  running: "处理中",
  done: "分析完成",
  failed: "处理失败",
};

function detailPath(asset: ApiV1AssetDetail) {
  const query = asset.user_id
    ? `?user_id=${encodeURIComponent(asset.user_id)}`
    : "";
  return `/assets/${asset.asset_id}${query}`;
}

export function AssetEditor({
  initialAsset,
}: {
  initialAsset: ApiV1AssetDetail;
}) {
  const router = useRouter();
  const [asset, setAsset] = useState(initialAsset);
  const [name, setName] = useState(initialAsset.name);
  const [description, setDescription] = useState(initialAsset.description);
  const [tagText, setTagText] = useState(
    initialAsset.tags.map((tag) => `${tag.category}:${tag.value}`).join("\n"),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const assetId = asset.asset_id;
  const assetStatus = asset.status;
  const assetUserId = asset.user_id;

  useEffect(() => {
    if (!["queued", "running"].includes(assetStatus)) return;
    const query = assetUserId
      ? `?user_id=${encodeURIComponent(assetUserId)}`
      : "";
    const path = `/assets/${assetId}${query}`;
    const timer = window.setInterval(async () => {
      try {
        const next = await uiApi<ApiV1AssetDetail>(path);
        setAsset(next);
        if (next.status === "done") {
          setDescription(next.description);
          setTagText(next.tags.map((tag) => `${tag.category}:${tag.value}`).join("\n"));
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
        .map((line) => {
          const separator = line.indexOf(":");
          return separator > 0
            ? {
                category: line.slice(0, separator).trim(),
                value: line.slice(separator + 1).trim(),
              }
            : { category: "custom", value: line };
        })
        .filter((tag) => tag.category && tag.value),
    [tagText],
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const task = await uiApi<TaskAccepted>(`/assets/${asset.asset_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_id: asset.user_id,
          name,
          description,
          tags: parsedTags,
        }),
      });
      await waitForTask(task);
      const next = await uiApi<ApiV1AssetDetail>(detailPath(asset));
      setAsset(next);
      setMessage("更改已保存。");
      router.refresh();
    });

  const publish = () =>
    run(async () => {
      const updateTask = await uiApi<TaskAccepted>(`/assets/${asset.asset_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_id: asset.user_id,
          name,
          description,
          tags: parsedTags,
        }),
      });
      await waitForTask(updateTask);
      const publishTask = await uiApi<TaskAccepted>(
        `/assets/${asset.asset_id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({ user_id: asset.user_id }),
        },
      );
      await waitForTask(publishTask);
      const next = await uiApi<ApiV1AssetDetail>(detailPath(asset));
      setAsset(next);
      setMessage("素材已正式入库。");
      router.refresh();
    });

  const retry = () =>
    run(async () => {
      const task = await uiApi<TaskAccepted>(
        `/assets/${asset.asset_id}/retry`,
        {
          method: "POST",
          body: JSON.stringify({ user_id: asset.user_id }),
        },
      );
      await waitForTask(task);
      const next = await uiApi<ApiV1AssetDetail>(detailPath(asset));
      setAsset(next);
      setMessage("已重新加入处理队列。");
    });

  const remove = () =>
    run(async () => {
      const action = asset.user_id
        ? "移出个人素材库并转为公共素材"
        : "永久删除公共素材及其文件";
      if (!window.confirm(`确认${action}？`)) return;
      const task = await uiApi<TaskAccepted>(`/assets/${asset.asset_id}`, {
        method: "DELETE",
        body: JSON.stringify({ user_id: asset.user_id }),
      });
      await waitForTask(task);
      router.push(appUrl("/"));
      router.refresh();
    });

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
              {asset.review_status === "published" ? "已入库" : "待审核"}
            </Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{asset.name}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {asset.original_filename} · {(asset.size_bytes / 1024 / 1024).toFixed(1)} MB
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
              download={asset.original_filename}
            >
              <Download className="size-4" /> 下载素材
            </a>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            <Trash2 className="size-4" /> 删除
          </Button>
        </div>
      </div>

      {asset.failure && (
        <div className="mb-6 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-medium">{asset.failure.message}</p>
            <p className="mt-1 font-mono text-xs">{asset.failure.code}</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="aspect-video min-h-72 bg-slate-100">
              <MediaPreview
                mediaType={asset.media_type}
                src={browserMediaUrl(asset.media_url)}
                name={asset.name}
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
            <h2 className="text-lg font-semibold">编辑素材信息</h2>
            <p className="mt-1 text-sm text-slate-500">
              标签每行一个，格式为“分类:标签”。
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <label className="block space-y-2">
              <span className="text-sm font-medium">素材名称</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">描述</span>
              <Textarea
                rows={6}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">标签</span>
              <Textarea
                rows={9}
                value={tagText}
                onChange={(event) => setTagText(event.target.value)}
              />
            </label>
            {message && (
              <p className="flex items-center gap-2 text-sm text-slate-600">
                <CheckCircle2 className="size-4 text-emerald-600" /> {message}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={save}>
                <Save className="size-4" /> 保存
              </Button>
              {asset.review_status === "pending_review" &&
                asset.status === "done" && (
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
  analysis: ApiV1AssetDetail["analysis"];
  description: string;
  tags: Array<{ category: string; value: string }>;
}) {
  if (!analysis) return null;
  const tagsByCategory = tags.reduce<Record<string, typeof tags>>(
    (groups, tag) => {
      (groups[tag.category] ??= []).push(tag);
      return groups;
    },
    {},
  );
  if (analysis.kind === "image") {
    return (
      <div className="space-y-5 text-sm">
        <p className="leading-7 text-slate-700">{description}</p>
        {Object.entries(tagsByCategory).map(([category, values]) => (
          <div key={category}>
            <p className="mb-2 font-medium text-slate-500">{category}</p>
            <div className="flex flex-wrap gap-2">
              {values?.map((tag) => (
                <Badge key={`${tag.category}-${tag.value}`}>{tag.value}</Badge>
              ))}
            </div>
          </div>
        ))}
        <div>
          <p className="mb-2 font-medium text-slate-500">OCR</p>
          <p>{analysis.ocr.text ?? analysis.ocr.unavailable_reason ?? "无可识别文本"}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5 text-sm">
      <p className="leading-7 text-slate-700">{description}</p>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Badge key={`${tag.category}-${tag.value}`}>{tag.value}</Badge>
        ))}
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
          {items.map((item) => (
            <li key={`${item.time}-${item.summary}`}>
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
