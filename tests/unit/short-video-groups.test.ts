import { describe, expect, it } from "vitest";
import type { AssetSummary } from "@/shared/contracts";
import type { DescriptionSearchResult } from "@/server/repositories/assets";
import { addShortVideoGroups, closestShortVideos, fitShortVideoGroups, type MatchMaterial } from "@/server/services/short-video-groups";
import { balancedAssetAssignment } from "@/server/services/balanced-asset-assignment";

const item = (id: string): AssetSummary => ({ id, name: id, description: "居家画面", mediaType: "video",
  processingStatus: "completed", reviewStatus: "published", tags: [], mediaUrl: `/media/${id}`, createdAt: "", searchScore: 0.5 });
const timeline = Array.from({ length: 9 }, (_, i) => ({ start_time: i * 2, end_time: (i + 1) * 2 }));
const search = (durations: Record<string, number>): DescriptionSearchResult => ({ items: Object.keys(durations).map(item),
  matchQualities: Object.fromEntries(Object.keys(durations).map(id => [id, 0.65])),
  shortVideoDurations: durations, threshold: 0, maxScore: 0.5, reason: "matched", message: null });

describe("short video combinations", () => {
  it("cannot pad a short video with another public/private copy of itself", () => {
    const found = search({ a: 1200, b: 1200 });
    found.mediaIdentities = { a: "same-file", b: "same-file" };
    expect(addShortVideoGroups(timeline.slice(0, 1), [[]], [found])).toEqual([[]]);
    const parts = found.items.map(item => ({ ...item, mediaIdentity: "same-file" }));
    expect(closestShortVideos(parts, found.shortVideoDurations!, 2500)).toBeUndefined();
  });

  it("does not extend a group with a copy already assigned to another segment", () => {
    const found = search({ a: 1000, b: 1000, c: 1000 });
    found.mediaIdentities = { c: "occupied" };
    const assignment = new Map<number, MatchMaterial>([
      [0, { ...item("regular"), mediaIdentity: "occupied" }],
      [1, { ...item("group"), matchQuality: 0.65, parts: [item("a"), item("b")] }],
    ]);
    fitShortVideoGroups([{ start_time: 0, end_time: 2 }, { start_time: 2, end_time: 6 }], assignment, [search({}), found]);
    expect(assignment.get(1)?.parts?.map(part => part.id)).toEqual(["a", "b"]);
  });

  it("finds exactly 0.9 + 1.1 seconds instead of greedily taking 1.9 + 1.8 for a short target", () => {
    const found = search({ a: 1900, b: 1800, c: 900, d: 1100 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 1480)?.map(part => part.id)).toEqual(["c", "d"]);
  });
  it("keeps a combination shorter than the target if it still reaches two seconds", () => {
    const found = search({ a: 1200, b: 1300 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 5000)?.map(part => part.id)).toEqual(["a", "b"]);
  });
  it("rejects insufficient, unknown and repeated footage", () => {
    const found = search({ a: 999, b: 1000, long: 2000, zero: 0 });
    expect(closestShortVideos(found.items, found.shortVideoDurations!, 1480)).toBeUndefined();
    expect(closestShortVideos([item("a"), item("a"), item("unknown")], { a: 1600 }, 1480)).toBeUndefined();
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
  it("allows a better short combination to compete with a weaker regular video", () => {
    const regular = [[{ ...item("long"), matchQuality: 0.55 }]];
    const short = { ...search({ a: 1500, b: 1500 }), matchQualities: { a: 0.7, b: 0.68 } };
    const selected = balancedAssetAssignment(timeline.slice(0, 1), addShortVideoGroups(timeline.slice(0, 1), regular, [short]));
    expect(selected.get(0)?.parts?.map(part => part.id)).toEqual(["a", "b"]);
  });
  it("does not reserve invisible components for a subsecond target", () => {
    const short = search({ a: 1500, b: 1500 });
    expect(addShortVideoGroups([{ start_time: 0, end_time: 0.44 }], [[]], [short])).toEqual([[]]);
    expect(addShortVideoGroups([{ start_time: 0, end_time: 0.44 }], [[]], [short], false)[0]).not.toHaveLength(0);
  });
  it("accounts for output frame rounding before reserving another source", () => {
    const short = search({ a: 1450, b: 1450 });
    const segment = { start_time: 0, end_time: 1.48 };
    expect(addShortVideoGroups([segment], [[]], [short])).toEqual([[]]);
    expect(closestShortVideos(short.items, short.shortVideoDurations!, 1480)).toBeUndefined();
  });
  it("requires matching evidence inside each member's actual played prefix", () => {
    const short = search({ a: 1000, b: 1000 });
    short.playbackEvidence = {
      a: [{ kind: "point", startMs: 900, similarity: 0.7 }], b: [{ kind: "point", startMs: 900, similarity: 0.7 }],
    };
    expect(addShortVideoGroups([{ start_time: 0, end_time: 1.48 }], [[]], [short])).toEqual([[]]);
    short.playbackEvidence.b[0].startMs = 200;
    const pools = addShortVideoGroups([{ start_time: 0, end_time: 1.48 }], [[]], [short]);
    expect(pools[0][0].parts?.map(part => part.id)).toEqual(["a", "b"]);
  });
  it("uses spare clips to approach the actual assigned slot instead of stopping at the minimum duration", () => {
    const segments = [{ start_time: 0, end_time: 1.48 }, { start_time: 2, end_time: 9.5 }];
    const searches = segments.map(() => search({ a: 700, b: 1300, c: 1500, d: 1500, e: 1500, f: 1500, g: 1500, h: 1500 }));
    const assignment = balancedAssetAssignment(segments, addShortVideoGroups(segments, [[], []], searches));
    fitShortVideoGroups(segments, assignment, searches);
    expect(assignment.get(0)?.parts?.length).toBe(2);
    expect(assignment.get(1)?.parts?.length).toBe(5);
    expect(new Set([...assignment.values()].flatMap(item => item.parts!.map(part => part.id))).size).toBe(7);
  });
});
