import type { AssetDetail } from "@/shared/contracts";
import { unusableVisualReason } from "@/server/media/material-quality";

export interface PlaybackEvidence {
  kind: "point" | "range" | "static" | "unknown" | "summary" | "theme";
  startMs?: number;
  endMs?: number;
  similarity: number;
}

/** A range summary is verified only once its entire interval has played. */
export function evidenceInWindow(evidence: Omit<PlaybackEvidence, "similarity">, durationMs: number) {
  if (evidence.kind === "static" || evidence.kind === "unknown") return true;
  if (evidence.kind === "point") return evidence.startMs !== undefined && evidence.startMs < durationMs;
  return evidence.kind === "range" && evidence.endMs !== undefined && evidence.endMs <= durationMs;
}

/** Keep timed facts separate from whole-video descriptions and current editable tags. */
export function assetEvidence(asset: Pick<AssetDetail, "description" | "analysis" | "tags">) {
  const analysis = asset.analysis;
  const timed: Array<{ content: string; kind: "point" | "range"; startMs: number; endMs: number }> = [];
  if (analysis?.kind === "video") {
    for (const item of [...analysis.visualSegments, ...analysis.timeline]) {
      if (item.summary.trim() && Number.isFinite(item.startSeconds) && Number.isFinite(item.endSeconds) && item.startSeconds >= 0 && item.endSeconds > item.startSeconds) {
        timed.push({ content: item.summary.trim(), kind: "range", startMs: Math.round(item.startSeconds * 1000), endMs: Math.round(item.endSeconds * 1000) });
      }
    }
    for (const item of analysis.keyMoments) if (item.summary.trim() && Number.isFinite(item.seconds) && item.seconds >= 0) {
      timed.push({ content: item.summary.trim(), kind: "point", startMs: Math.round(item.seconds * 1000), endMs: Math.round(item.seconds * 1000) });
    }
  }
  const unusable = unusableVisualReason(asset.description) || unusableVisualReason(analysis?.description ?? "");
  const chunks = unusable ? [] : [
    ...(asset.description.trim() ? [{ content: asset.description.trim(), kind: analysis?.kind === "image" ? "static" as const : timed.length ? "summary" as const : "unknown" as const }] : []),
    ...timed,
  ];
  const facets = Object.fromEntries(["topic", "scene", "person", "object"].map(category => [category,
    [...new Set(asset.tags.filter(tag => tag.category === category).map(tag => tag.value.trim()).filter(value =>
      value && !["城市风貌", "建筑", "科技", "财经", "社会场景", "无人物"].includes(value)))],
  ]));
  return { chunks: [...new Map(chunks.map(chunk => [JSON.stringify(chunk), chunk])).values()], facets,
    theme: unusable ? "" : facets.topic.join("，") };
}
