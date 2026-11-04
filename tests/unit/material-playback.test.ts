import { describe, expect, it } from "vitest";
import { planMaterialPlayback } from "@/server/services/material-playback";

const video = (index: number, start: number, duration: number) => ({ index, start, duration, type: "video" as const });
const image = (index: number, start: number) => ({ index, start, duration: 3, type: "image" as const });

describe("audio-bounded material overlays", () => {
  it.each([0, 0.001, 0.233, 0.999, 1, 1.001])("bridges only strictly sub-second gaps: %s", gap => {
    const items = [video(0, 2, 2), video(1, 4 + gap, 2)];
    const before = structuredClone(items);
    const playback = planMaterialPlayback(items, 20);
    const fill = gap > 0 && gap < 1;
    expect(playback.get(0)).toEqual({ start: 2, end: fill ? 4 + gap : 4, loop: fill ? gap : 0 });
    expect(playback.get(1)).toMatchObject({ start: 4 + gap, loop: 0 });
    expect(playback.get(1)!.end).toBeCloseTo(6 + gap, 9);
    expect(items).toEqual(before);
  });

  it("does not bridge the leading or trailing avatar interval", () => {
    expect([...planMaterialPlayback([video(0, .2, 2)], 2.8).values()])
      .toEqual([{ start: .2, end: 2.2, loop: 0 }]);
  });

  it("replays a tiny source as often as necessary without padding it to three seconds", () => {
    const playback = planMaterialPlayback([video(0, 0, .2), video(1, 1, .3)], 10);
    expect(playback.get(0)).toEqual({ start: 0, end: 1, loop: .8 });
    expect(playback.get(1)).toEqual({ start: 1, end: 1.3, loop: 0 });
  });

  it("cuts long videos at the next match or exact audio end", () => {
    const duration = 81.09133333333334;
    const playback = planMaterialPlayback([video(0, 60, 24.7), video(1, 66.24, 30)], duration);
    expect(playback.get(0)).toEqual({ start: 60, end: 66.24, loop: 0 });
    expect(playback.get(1)).toEqual({ start: 66.24, end: duration, loop: 0 });
  });

  it("gives photos one second and delays only the overlay, including chained photos", () => {
    const playback = planMaterialPlayback([image(0, 0), image(1, .4), video(2, .8, 2)], 10);
    expect([...playback.values()]).toEqual([
      { start: 0, end: 1, loop: 0 }, { start: 1, end: 2, loop: 0 }, { start: 2, end: 4, loop: 0 },
    ]);
  });

  it.each([2, 3, 3.5, 4])("caps a photo at three seconds except for the short-gap fallback: next=%s", next => {
    expect(planMaterialPlayback([image(0, 0), video(1, next, 1)], 10).get(0))
      .toEqual({ start: 0, end: next < 4 ? next : 3, loop: 0 });
  });

  it("never extends the audio for a photo that cannot fit its minimum", () => {
    expect(planMaterialPlayback([image(0, 9.4), video(1, 11, 2)], 10).size).toBe(0);
  });

  it("drops a video superseded at the same delayed start and skips unknown durations", () => {
    const playback = planMaterialPlayback([image(0, 0), video(1, .2, 5), video(2, .4, 2), video(3, 8, 0)], 10);
    expect([...playback.keys()]).toEqual([0, 2]);
    expect(playback.get(2)).toEqual({ start: 1, end: 3, loop: 0 });
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid audio duration %s", duration => {
    expect(() => planMaterialPlayback([], duration)).toThrow();
  });

  it("rejects invalid material timestamps and durations", () => {
    for (const item of [video(0, -1, 1), video(0, NaN, 1), video(0, 1, Infinity)]) {
      expect(() => planMaterialPlayback([item], 10)).toThrow();
    }
  });
});
