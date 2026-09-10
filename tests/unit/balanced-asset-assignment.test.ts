import { describe, expect, it, vi } from "vitest";
import { balancedAssetAssignment } from "@/server/services/balanced-asset-assignment";

vi.mock("node:crypto", () => ({ randomInt: () => 0 }));

const segments = Array.from({ length: 9 }, (_, i) => ({ start_time: i, end_time: i + 1 }));
const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };

describe("balanced material placement", () => {
  it("reserves public/private copies as one source and reallocates the alternate material", () => {
    const pools = [
      [{ id: "public", mediaIdentity: "same-file", matchQuality: 0.6 }, { id: "other", matchQuality: 0.59 }],
      [{ id: "private", mediaIdentity: "same-file", matchQuality: 0.7 }],
    ];
    const selected = balancedAssetAssignment(segments.slice(0, 2), pools);
    expect([...selected].map(([index, item]) => [index, item.id])).toEqual([[0, "other"], [1, "private"]]);
  });

  it("keeps a strong people match instead of filling another slot with an empty factory", () => {
    const pools = segments.map(() => [] as { id: string; matchQuality: number }[]);
    pools[0] = [{ id: "people", matchQuality: 0.535 }];
    pools[4] = [{ id: "people", matchQuality: 0.605 }, { id: "factory", matchQuality: 0.518 }];
    expect([...balancedAssetAssignment(segments, pools).entries()].map(([index, asset]) => [index, asset.id]))
      .toEqual([[4, "people"]]);
  });

  it("prefers a stronger supported placement over the most evenly spaced one", () => {
    const pools = segments.map(() => [] as { id: string; matchQuality: number }[]);
    pools[0] = [{ id: "asset", matchQuality: 0.61 }];
    pools[4] = [{ id: "asset", matchQuality: 0.58 }];
    expect([...balancedAssetAssignment(segments, pools).keys()]).toEqual([0]);
  });

  it("does not trade the best people match for two weaker matches to increase coverage", () => {
    const pools = segments.map(() => [] as { id: string; matchQuality: number }[]);
    pools[0] = [{ id: "people", matchQuality: 0.512 }];
    pools[4] = [{ id: "people", matchQuality: 0.544 }, { id: "phone", matchQuality: 0.513 }];
    expect([...balancedAssetAssignment(segments, pools)].map(([index, asset]) => [index, asset.id]))
      .toEqual([[4, "people"]]);
  });

  it("uses the configured semantic threshold as the gain baseline", () => {
    expect(balancedAssetAssignment(segments.slice(0, 1), [[{ id: "asset", matchQuality: 0.45 }]]).size).toBe(0);
    expect(balancedAssetAssignment(segments.slice(0, 1), [[{ id: "asset", matchQuality: 0.45 }]], false, 0.4).size).toBe(1);
  });

  it("preserves recall scores when random selection is enabled", () => {
    const strong = { id: "strong", searchScore: 0.6 }, weak = { id: "weak", searchScore: 0.4 };
    expect(balancedAssetAssignment(segments.slice(0, 1), [[strong, weak]], true).get(0)).toBe(strong);
  });
  it("still randomizes equally scored candidates", () => {
    const left = { id: "left", searchScore: 0.5 }, right = { id: "right", searchScore: 0.5 };
    expect(balancedAssetAssignment(segments.slice(0, 1), [[left, right]], true).get(0)).toBe(right);
  });
  it("spreads three reusable candidates across the whole timeline instead of consuming them at the start", () => {
    const result = balancedAssetAssignment(segments, segments.map(() => [a, b, c]));
    expect([...result.keys()].sort((x, y) => x - y)).toEqual([1, 4, 7]);
    expect(new Set([...result.values()].map(x => x.id)).size).toBe(3);
  });
  it("reserves a shared asset for the end when an alternative can cover the beginning", () => {
    const pools = segments.map(() => [] as { id: string }[]);
    pools[0] = [a]; pools[1] = [b]; pools[8] = [a];
    const result = balancedAssetAssignment(segments, pools);
    expect([...result.entries()].map(([index, asset]) => [index, asset.id])).toEqual([[1, "b"], [8, "a"]]);
  });
  it("never assigns unsupported assets or more than one asset to a segment", () => {
    const pools = segments.map(() => [] as { id: string }[]);
    pools[4] = [a, b, c];
    const result = balancedAssetAssignment(segments, pools);
    expect(result.size).toBe(1);
    expect(result.get(4)?.id).toBe("a");
    expect(balancedAssetAssignment(segments, segments.map(() => [])).size).toBe(0);
  });

  it("agrees with exhaustive maximum coverage and minimum timing cost on every small candidate graph", () => {
    const timeline = segments.slice(0, 3);
    const timingCost = (positions: number[]) => positions.reduce((sum, position, index) =>
      sum + ((position + 0.5) / 3 - (index + 0.5) / positions.length) ** 2, 0);
    for (let mask = 0; mask < 64; mask++) {
      const pools = timeline.map((_, i) => [a, b].filter((_, j) => mask & (1 << (i * 2 + j))));
      let maximum = 0, minimum = Infinity;
      const visit = (index: number, used: Set<string>, positions: number[]) => {
        if (index === timeline.length) {
          const cost = timingCost(positions);
          if (positions.length > maximum) { maximum = positions.length; minimum = cost; }
          else if (positions.length === maximum) minimum = Math.min(minimum, cost);
          return;
        }
        visit(index + 1, used, positions);
        for (const asset of pools[index]) if (!used.has(asset.id)) {
          visit(index + 1, new Set([...used, asset.id]), [...positions, index]);
        }
      };
      visit(0, new Set(), []);
      const result = balancedAssetAssignment(timeline, pools);
      expect(result.size).toBe(maximum);
      expect(timingCost([...result.keys()].sort((x, y) => x - y))).toBeCloseTo(minimum, 7);
    }
  });
});
