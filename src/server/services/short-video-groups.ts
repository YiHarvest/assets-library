import type { AssetSummary } from "@/shared/contracts";
import type { DescriptionSearchResult } from "@/server/repositories/assets";
import { balancedAssetAssignment } from "./balanced-asset-assignment";

export type MatchMaterial = AssetSummary & { parts?: AssetSummary[] };

function group(parts: AssetSummary[]): MatchMaterial {
  return { ...parts[0], id: `concat:${parts.map(part => part.id).join(",")}`, parts,
    description: parts.map(part => part.description).join("；"),
    searchScore: parts.reduce((sum, part) => sum + (part.searchScore ?? 0), 0) / parts.length };
}

/** 毫秒子集和：至少 3 秒，优先接近目标，再少用素材；不重复片段。 */
export function closestShortVideos(items: AssetSummary[], durations: Record<string, number>, targetMs: number) {
  const target = Math.max(3000, Math.round(targetMs));
  const sums = new Map<number, AssetSummary[]>([[0, []]]);
  for (const item of new Map(items.map(item => [item.id, item])).values()) {
    const duration = durations[item.id];
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration >= 3000) continue;
    for (const [total, parts] of [...sums]) {
      const next = total + duration;
      if (next >= target + 3000) continue;
      if (!sums.has(next) || sums.get(next)!.length > parts.length + 1) sums.set(next, [...parts, item]);
    }
  }
  return [...sums].filter(([total]) => total >= 3000).sort(([a, left], [b, right]) =>
    Math.abs(a - target) - Math.abs(b - target) || left.length - right.length || a - b)[0]?.[1];
}

/** 先形成互不占用源片段的组合，再交给已有全局分配器安排时间轴。 */
export function addShortVideoGroups(
  segments: { start_time: number; end_time: number }[],
  regularPools: AssetSummary[][],
  searches: DescriptionSearchResult[],
): MatchMaterial[][] {
  const pools: MatchMaterial[][] = regularPools.map(pool => [...pool]);
  const used = new Set<string>();
  let coverage = balancedAssetAssignment(segments, pools).size;
  // 先处理候选少的文本，组合仍可被任何成员全部过线的文本选用。
  const order = searches.map((_, index) => index).sort((a, b) => searches[a].items.length - searches[b].items.length);
  for (const index of order) {
    while (coverage < segments.length) {
      const search = searches[index];
      const parts = closestShortVideos(search.items.filter(item => !used.has(item.id)), search.shortVideoDurations ?? {},
        (segments[index].end_time - segments[index].start_time) * 1000);
      if (!parts) break;
      const next = pools.map((pool, segment) => {
        const members = parts.map(part => searches[segment].items.find(item => item.id === part.id)).filter(member => member !== undefined);
        return members.length === parts.length ? [...pool, group(members)] : pool;
      });
      const nextCoverage = balancedAssetAssignment(segments, next).size;
      if (nextCoverage <= coverage) break;
      pools.splice(0, pools.length, ...next);
      parts.forEach(part => used.add(part.id));
      coverage = nextCoverage;
    }
  }
  return pools;
}

/** 分配到实际文本时段后，用剩余合格片段调整时长，不占用其他已分配组合。 */
export function fitShortVideoGroups(
  segments: { start_time: number; end_time: number }[], assignment: Map<number, MatchMaterial>, searches: DescriptionSearchResult[],
) {
  const reserved = new Set([...assignment.values()].flatMap(item => item.parts?.map(part => part.id) ?? []));
  const target = (index: number) => (segments[index].end_time - segments[index].start_time) * 1000;
  for (const [index, material] of [...assignment].sort(([a], [b]) => target(b) - target(a))) {
    if (!material.parts) continue;
    const own = new Set(material.parts.map(part => part.id));
    const search = searches[index];
    const parts = closestShortVideos(search.items.filter(item => !reserved.has(item.id) || own.has(item.id)), search.shortVideoDurations ?? {}, target(index));
    if (!parts) continue;
    own.forEach(id => reserved.delete(id));
    parts.forEach(part => reserved.add(part.id));
    assignment.set(index, group(parts));
  }
}
