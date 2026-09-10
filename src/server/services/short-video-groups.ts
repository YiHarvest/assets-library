import type { AssetSummary } from "@/shared/contracts";
import type { DescriptionSearchResult } from "@/server/repositories/assets";
import { candidateIdentity, matchQuality, type MatchCandidate } from "./balanced-asset-assignment";
import { evidenceInWindow } from "@/server/search/asset-evidence";

export type MatchMaterial = AssetSummary & MatchCandidate & { parts?: MatchMaterial[] };

// 拼接输出固定 25 fps，与 FFmpeg 的逐片向上取帧、成片向下取帧保持一致。
const sourceFrames = (durationMs: number) => Math.ceil(durationMs / 40);

function group(parts: MatchMaterial[], durations: Record<string, number>, targetMs: number): MatchMaterial | undefined {
  if (new Set(parts.map(candidateIdentity)).size !== parts.length) return;
  let remaining = Math.floor(targetMs / 40) * 40, played = 0, quality = 0;
  for (const part of parts) {
    const duration = Math.min(remaining, sourceFrames(durations[part.id]) * 40);
    const evidence = part.playbackEvidence?.filter(item => evidenceInWindow(item, Math.min(duration, durations[part.id])) && item.similarity > 0.5);
    if (evidence && !evidence.length) return;
    quality += duration * Math.min(matchQuality(part), evidence ? Math.max(...evidence.map(item => item.similarity)) : Infinity);
    played += duration;
    remaining -= duration;
  }
  return { ...parts[0], id: `concat:${parts.map(part => part.id).sort().join(",")}`, parts,
    mediaIdentity: `concat:${parts.map(candidateIdentity).sort().join(",")}`,
    description: parts.map(part => part.description).join("；"),
    matchQuality: parts.every(part => part.matchQuality !== undefined) ? quality / played : undefined,
    searchScore: parts.reduce((sum, part) => sum + (part.searchScore ?? 0), 0) / parts.length };
}

/** 毫秒子集和：至少 2 秒，优先接近目标，再少用素材；不重复片段。 */
export function closestShortVideos(items: MatchMaterial[], durations: Record<string, number>, targetMs: number, clipEnabled = true, initial: MatchMaterial[] = []) {
  const target = Math.max(2000, Math.round(targetMs));
  const sums = new Map<number, MatchMaterial[]>([[initial.reduce((sum, item) => sum + durations[item.id], 0), initial]]);
  for (const item of new Map(items.map(item => [item.id, item])).values()) {
    if (initial.some(part => candidateIdentity(part) === candidateIdentity(item))) continue;
    const duration = durations[item.id];
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration >= 2000) continue;
    for (const [total, parts] of [...sums]) {
      if (parts.some(part => candidateIdentity(part) === candidateIdentity(item))) continue;
      if (clipEnabled && parts.reduce((frames, part) => frames + sourceFrames(durations[part.id]), 0) >= Math.floor(targetMs / 40)) continue;
      const next = total + duration;
      if (next >= target + 2000) continue;
      if (!sums.has(next) || sums.get(next)!.length > parts.length + 1) sums.set(next, [...parts, item]);
    }
  }
  return [...sums].filter(([total]) => total >= 2000).sort(([a, left], [b, right]) =>
    Math.abs(a - target) - Math.abs(b - target) || left.length - right.length || a - b)[0]?.[1];
}

/** 各文本独立产生组合候选，不预占源片段；分配器统一处理组合冲突。 */
export function addShortVideoGroups(
  segments: { start_time: number; end_time: number }[],
  regularPools: MatchMaterial[][],
  searches: DescriptionSearchResult[],
  clipEnabled = true,
): MatchMaterial[][] {
  return segments.map((segment, index) => {
    const search = searches[index], durations = search.shortVideoDurations ?? {};
    const items: MatchMaterial[] = search.items.map(item => ({ ...item, mediaIdentity: search.mediaIdentities?.[item.id], matchQuality: search.matchQualities?.[item.id], playbackEvidence: search.playbackEvidence?.[item.id] }))
      .sort((a, b) => matchQuality(b) - matchQuality(a));
    const target = Math.round((segment.end_time - segment.start_time) * 1000);
    const groups = new Map<string, MatchMaterial>();
    const add = (parts: MatchMaterial[] | undefined) => {
      if (!parts || parts.length < 2) return;
      const material = group(parts, durations, clipEnabled ? target : Infinity);
      if (!material) return;
      material.durationPenalty = 0.005 * Math.abs(parts.reduce((sum, part) => sum + durations[part.id], 0) - Math.max(2000, target)) / Math.max(2000, target);
      if (!groups.has(material.id) || matchQuality(material) > matchQuality(groups.get(material.id)!)) groups.set(material.id, material);
    };
    items.forEach((first, i) => {
      if (!Number.isSafeInteger(durations[first.id]) || durations[first.id] <= 0 || durations[first.id] >= 2000 ||
        (clipEnabled && sourceFrames(durations[first.id]) >= Math.floor(target / 40))) return;
      // 大池按语义排名循环保留搭档，避免 O(n²) 组合挤占分配资源；子集和另找接近时长的组。
      const alternatives = [...items.slice(i + 1), ...items.slice(0, i)];
      for (const second of (items.length > 16 ? alternatives.slice(0, 8) : alternatives)) if (Number.isSafeInteger(durations[second.id]) && durations[second.id] > 0 && durations[second.id] < 2000 &&
        durations[first.id] + durations[second.id] >= 2000) add([first, second]);
      add(closestShortVideos([...items.slice(i), ...items.slice(0, i)], durations, target, clipEnabled, [first]));
    });
    return [...regularPools[index], ...groups.values()];
  });
}

/** 分配到实际文本时段后，用剩余合格片段调整时长，不占用其他已分配组合。 */
export function fitShortVideoGroups(
  segments: { start_time: number; end_time: number }[], assignment: Map<number, MatchMaterial>, searches: DescriptionSearchResult[], clipEnabled = true,
) {
  const reserved = new Set([...assignment.values()].flatMap(item => (item.parts ?? [item]).map(candidateIdentity)));
  const target = (index: number) => (segments[index].end_time - segments[index].start_time) * 1000;
  for (const [index, material] of [...assignment].sort(([a], [b]) => target(b) - target(a))) {
    if (!material.parts) continue;
    const own = new Set(material.parts.map(candidateIdentity));
    const search = searches[index];
    const durations = search.shortVideoDurations ?? {};
    if (material.parts.reduce((sum, part) => sum + durations[part.id], 0) >= target(index)) continue;
    const items = search.items.map(item => ({ ...item, mediaIdentity: search.mediaIdentities?.[item.id], matchQuality: search.matchQualities?.[item.id], playbackEvidence: search.playbackEvidence?.[item.id] }));
    const parts = closestShortVideos(items.filter(item => !reserved.has(candidateIdentity(item)) && matchQuality(item) >= matchQuality(material) - 0.05),
      durations, target(index), clipEnabled, material.parts);
    if (!parts) continue;
    const fitted = group(parts, durations, clipEnabled ? target(index) : Infinity);
    if (!fitted) continue;
    own.forEach(id => reserved.delete(id));
    parts.forEach(part => reserved.add(candidateIdentity(part)));
    assignment.set(index, fitted);
  }
}
