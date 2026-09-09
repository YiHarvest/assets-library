import { describe, expect, it } from "vitest";
import type { AssetSummary } from "@/shared/contracts";
import type { DescriptionSearchResult } from "@/server/repositories/assets";
import { addShortVideoGroups, closestShortVideos, fitShortVideoGroups } from "@/server/services/short-video-groups";
import { balancedAssetAssignment } from "@/server/services/balanced-asset-assignment";

const item = (id: string): AssetSummary => ({ id, name: id, description: "居家画面", mediaType: "video",
  processingStatus: "completed", reviewStatus: "published", tags: [], mediaUrl: `/media/${id}`, createdAt: "", searchScore: 0.5 });
const timeline = Array.from({ length: 9 }, (_, i) => ({ start_time: i, end_time: i + 1 }));
const search = (durations: Record<string, number>): DescriptionSearchResult => ({ items: Object.keys(durations).map(item),
  shortVideoDurations: durations, threshold: 0, maxScore: 0.5, reason: "matched", message: null });

describe("short video combinations", () => {
  it("finds 1.4 + 1.6 instead of greedily taking 2.9 + 2.8 for a short target", () => {
    const found = search({ a: 2900, b: 2800, c: 1400, d: 1600 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 1480)?.map(part => part.id)).toEqual(["c", "d"]);
  });
  it("keeps a combination shorter than the target if it still reaches three seconds", () => {
    const found = search({ a: 2200, b: 2300 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 5000)?.map(part => part.id)).toEqual(["a", "b"]);
  });
  it("rejects insufficient, unknown and repeated footage", () => {
    const found = search({ a: 1400, b: 1500, long: 3000, zero: 0 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 3000)).toBeUndefined();
    expect(closestShortVideos([item("a"), item("a"), item("unknown")], { a: 1600 }, 3000)).toBeUndefined();
  });
  it("distributes disjoint combinations through the timeline without using a source twice", () => {
    const searches = timeline.map(() => search({ a: 1500, b: 1500, c: 1500, d: 1500, e: 1500, f: 1500 }));
    const pools = addShortVideoGroups(timeline, timeline.map(() => []), searches);
    const selected = balancedAssetAssignment(timeline, pools);
    expect([...selected.keys()]).toEqual([1, 4, 7]);
    const sources = [...selected.values()].flatMap(material => material.parts!.map(part => part.id));
    expect(new Set(sources).size).toBe(6);
  });
  it("reserves scarce later matches and requires every component to match the assigned text", () => {
    const searches = timeline.map(() => search({}));
    searches[0] = search({ a: 1500, b: 1500, c: 1500, d: 1500 });
    searches[8] = search({ a: 1500, b: 1500 });
    const selected = balancedAssetAssignment(timeline, addShortVideoGroups(timeline, timeline.map(() => []), searches));
    expect([...selected.keys()]).toEqual([0, 8]);
    expect(selected.get(8)?.parts?.map(part => part.id)).toEqual(["a", "b"]);
    const unrelated = [search({ a: 1600 }), search({ b: 1600 })];
    expect(addShortVideoGroups(timeline.slice(0, 2), [[], []], unrelated)).toEqual([[], []]);
  });
  it("preserves existing complete coverage", () => {
    const regular = [[item("long")]];
    expect(addShortVideoGroups(timeline.slice(0, 1), regular, [search({ a: 1500, b: 1500 })])).toEqual(regular);
  });
  it("uses spare clips to approach the actual assigned slot instead of leaving a long slot at three seconds", () => {
    const segments = [{ start_time: 0, end_time: 1.48 }, { start_time: 2, end_time: 9.5 }];
    const searches = segments.map(() => search({ a: 1500, b: 1500, c: 1500, d: 1500, e: 1500, f: 1500, g: 1500, h: 1500 }));
    const assignment = balancedAssetAssignment(segments, addShortVideoGroups(segments, [[], []], searches));
    fitShortVideoGroups(segments, assignment, searches);
    expect(assignment.get(0)?.parts?.length).toBe(2);
    expect(assignment.get(1)?.parts?.length).toBe(5);
    expect(new Set([...assignment.values()].flatMap(item => item.parts!.map(part => part.id))).size).toBe(7);
  });
});
