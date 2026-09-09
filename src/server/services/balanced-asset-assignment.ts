import { randomInt } from "node:crypto";

interface Edge { to: number; reverse: number; capacity: number; cost: number }

/** Maximize supported matches, then minimize distance to evenly spaced time slots. */
export function balancedAssetAssignment<T extends { id: string }>(
  segments: readonly { start_time: number; end_time: number }[], pools: readonly (readonly T[])[], isRandom = false,
): Map<number, T> {
  const ids = [...new Set(pools.flatMap(pool => pool.map(asset => asset.id)))];
  if (!ids.length || !segments.length) return new Map();
  const preferences = pools.map(pool => {
    const copy = [...pool];
    if (isRandom) for (let i = copy.length - 1; i > 0; i--) {
      const j = randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  });
  const start = Math.min(...segments.map(segment => segment.start_time));
  const duration = Math.max(0.001, Math.max(...segments.map(segment => segment.end_time)) - start);
  const allocate = (slots: number): Map<number, T> => {
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
      preferences[index].forEach((asset, rank) => choices.push({ index, asset,
        edge: edge(assetNodes.get(asset.id)!, input, rank * 1e-9) }));
      const position = ((segment.start_time + segment.end_time) / 2 - start) / duration;
      for (let slot = 0; slot < slots; slot++) edge(input + 1, firstSlot + slot, (position - (slot + 0.5) / slots) ** 2);
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
      if (!previous[sink]) break;
      for (let to = sink; to !== 0;) {
        const [from, index] = previous[to]!;
        const next = graph[from][index]; next.capacity--; graph[to][next.reverse].capacity++;
        to = from;
      }
    }
    const selected = new Map(choices.filter(choice => !choice.edge.capacity).map(choice => [choice.index, choice.asset]));
    // Re-space the targets if the candidate graph cannot support the initial count.
    return selected.size && selected.size < slots ? allocate(selected.size) : selected;
  };
  return allocate(Math.min(ids.length, segments.length));
}
