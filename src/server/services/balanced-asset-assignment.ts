import { randomInt } from "node:crypto";
import type { PlaybackEvidence } from "@/server/search/asset-evidence";

interface Edge { to: number; reverse: number; capacity: number; cost: number }

export interface MatchCandidate { id: string; mediaIdentity?: string; searchScore?: number; matchQuality?: number; playbackEvidence?: PlaybackEvidence[]; durationPenalty?: number; parts?: readonly { id: string; mediaIdentity?: string }[] }

export const matchQuality = (asset: MatchCandidate) => asset.matchQuality ?? asset.searchScore ?? 0;
export const candidateIdentity = (asset: Pick<MatchCandidate, "id" | "mediaIdentity">) => asset.mediaIdentity ?? asset.id;

/** Maximize semantic gain above the admission threshold, with a small placement cost. */
export function balancedAssetAssignment<T extends MatchCandidate>(
  segments: readonly { start_time: number; end_time: number }[], pools: readonly (readonly T[])[], isRandom = false, minimumQuality = 0.5,
): Map<number, T> {
  const preferences = pools.map(pool => {
    const copy = [...pool];
    if (isRandom) for (let i = copy.length - 1; i > 0; i--) {
      const j = randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    // 随机仅打破同分并列，保留语义与上下文的召回排序。
    return copy.sort((a, b) => matchQuality(b) - matchQuality(a) || (b.searchScore ?? 0) - (a.searchScore ?? 0));
  });
  const ids = [...new Set(preferences.flatMap(pool => pool.map(candidateIdentity)))];
  if (!ids.length || !segments.length) return new Map();
  const start = Math.min(...segments.map(segment => segment.start_time));
  const duration = Math.max(0.001, Math.max(...segments.map(segment => segment.end_time)) - start);
  // RRF-only callers retain their existing coverage behavior. Raw semantic evidence
  // allows leaving a slot empty when filling it would displace a stronger match.
  const assetCost = (asset: T) => (asset.matchQuality === undefined ? -1 - (asset.searchScore ?? 0)
    : minimumQuality - asset.matchQuality) + (asset.durationPenalty ?? 0);
  const allocate = (slots: number, available = preferences): Map<number, T> => {
    const firstSegment = 1 + ids.length;
    const firstSlot = firstSegment + segments.length * 2;
    const sink = firstSlot + slots;
    const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
    const edge = (from: number, to: number, cost = 0) => {
      const forward = { to, reverse: graph[to].length, capacity: 1, cost };
      graph[from].push(forward);
      graph[to].push({ to: from, reverse: graph[from].length - 1, capacity: 0, cost: -cost });
      return forward;
    };
    const assetNodes = new Map(ids.map((id, index) => [id, index + 1]));
    ids.forEach(id => edge(0, assetNodes.get(id)!));
    const choices: { index: number; asset: T; edge: Edge }[] = [];
    segments.forEach((segment, index) => {
      const input = firstSegment + index * 2;
      edge(input, input + 1);
      available[index].forEach((asset, rank) => choices.push({ index, asset,
        edge: edge(assetNodes.get(candidateIdentity(asset))!, input, assetCost(asset) + rank * 1e-9) }));
      const position = ((segment.start_time + segment.end_time) / 2 - start) / duration;
      for (let slot = 0; slot < slots; slot++) edge(input + 1, firstSlot + slot, 0.02 * (position - (slot + 0.5) / slots) ** 2);
    });
    for (let slot = 0; slot < slots; slot++) edge(firstSlot + slot, sink);
    // Residual edges allow an early choice to move when a later segment needs that asset.
    for (;;) {
      const distance = Array(graph.length).fill(Infinity);
      const previous: ([number, number] | undefined)[] = Array(graph.length);
      const queued = Array(graph.length).fill(false);
      const queue = [0]; distance[0] = 0; queued[0] = true;
      for (let head = 0; head < queue.length; head++) {
        const from = queue[head]; queued[from] = false;
        graph[from].forEach((next, index) => {
          const cost = distance[from] + next.cost;
          if (!next.capacity || cost >= distance[next.to] - 1e-12) return;
          distance[next.to] = cost; previous[next.to] = [from, index];
          if (!queued[next.to]) { queued[next.to] = true; queue.push(next.to); }
        });
      }
      if (!previous[sink] || distance[sink] >= 0) break;
      for (let to = sink; to !== 0;) {
        const [from, index] = previous[to]!;
        const next = graph[from][index]; next.capacity--; graph[to][next.reverse].capacity++;
        to = from;
      }
    }
    const selected = new Map(choices.filter(choice => !choice.edge.capacity).map(choice => [choice.index, choice.asset]));
    // Re-space the targets if the candidate graph cannot support the initial count.
    return selected.size && selected.size < slots ? allocate(selected.size, available) : selected;
  };
  const sourceIds = (asset: T) => asset.parts?.map(candidateIdentity) ?? [candidateIdentity(asset)];
  const singles = new Set(preferences.flat().filter(asset => !asset.parts).map(candidateIdentity));
  const extra = new Set(preferences.flatMap(pool => pool.flatMap(sourceIds)).filter(id => !singles.has(id)));
  const slots = Math.min(singles.size + Math.floor(extra.size / 2), segments.length);
  const solve = (blocked: Set<string>) => allocate(slots, preferences.map(pool => pool.filter(asset => !blocked.has(asset.id))));
  const conflict = (selected: Map<number, T>) => {
    const owners = new Map<string, T>();
    for (const asset of selected.values()) for (const id of sourceIds(asset)) {
      const owner = owners.get(id);
      if (owner) return [owner, asset];
      owners.set(id, asset);
    }
  };
  const cost = (selected: Map<number, T>) => [...selected].sort(([a], [b]) => segments[a].start_time - segments[b].start_time)
    .reduce((total, [index, asset], slot) => total + assetCost(asset) + 0.02 *
      (((segments[index].start_time + segments[index].end_time) / 2 - start) / duration - (slot + 0.5) / selected.size) ** 2, 0);
  const initial = solve(new Set());
  if (!conflict(initial)) return initial;
  // 组合共享源片段时，先得到可行方案，再有限搜索换组。普通视频仍只运行一次最小费用流。
  let best = initial;
  const blocked = new Set<string>();
  for (let pair = conflict(best); pair; pair = conflict(best)) {
    const keep = [...pair].sort((a, b) => matchQuality(b) - matchQuality(a))[0];
    const occupied = new Set(sourceIds(keep));
    for (const asset of preferences.flat()) if (asset.id !== keep.id && sourceIds(asset).some(id => occupied.has(id))) blocked.add(asset.id);
    best = solve(blocked);
  }
  const pending = [{ blocked: new Set<string>(), selected: initial }];
  const visited = new Set<string>();
  for (let attempt = 0; pending.length && attempt < 32; attempt++) {
    pending.sort((a, b) => cost(a.selected) - cost(b.selected));
    const state = pending.shift()!;
    if (cost(state.selected) >= cost(best) - 1e-12) continue;
    const pair = conflict(state.selected);
    if (!pair) { best = state.selected; continue; }
    for (const asset of pair) {
      const next = new Set([...state.blocked, asset.id]);
      const key = [...next].sort().join(";");
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push({ blocked: next, selected: solve(next) });
    }
  }
  return best;
}
