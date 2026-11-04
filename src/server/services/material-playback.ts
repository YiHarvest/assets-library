import { AppError } from "@/server/errors";

interface Material {
  index: number;
  start: number;
  type: "image" | "video";
  duration: number;
}

export interface MaterialPlayback { start: number; end: number; loop: number }

const seconds = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Subtitle time is immutable; only material overlays are delayed, cut or replayed. */
export function planMaterialPlayback(materials: readonly Material[], audioDuration: number) {
  if (!Number.isFinite(audioDuration) || audioDuration <= 0 || materials.some(item =>
    !Number.isFinite(item.start) || item.start < 0 || !Number.isFinite(item.duration) || item.duration < 0)) {
    throw new AppError("invalid_request", "素材播放时间及音频时长必须为有效的非负数，音频时长必须大于零。", 400);
  }
  const starts: Array<Material & { actualStart: number }> = [];
  for (const item of [...materials].sort((a, b) => a.start - b.start || a.index - b.index)) {
    if (item.type === "video" && item.duration === 0) continue;
    const previous = starts.at(-1);
    const actualStart = Math.max(item.start, previous ? seconds(previous.actualStart + (previous.type === "image" ? 1 : 0)) : 0);
    if (actualStart >= audioDuration || (item.type === "image" && seconds(actualStart + 1) > audioDuration)) continue;
    starts.push({ ...item, actualStart });
  }
  const placements = starts.flatMap((item, index) => {
    const end = Math.min(audioDuration, seconds(item.actualStart + (item.type === "image" ? 3 : item.duration)), starts[index + 1]?.actualStart ?? audioDuration);
    return end > item.actualStart ? [{ ...item, start: item.actualStart, end, loop: 0 }] : [];
  });
  for (let index = 0; index + 1 < placements.length; index++) {
    const current = placements[index], next = placements[index + 1];
    const gap = seconds(next.start - current.end);
    if (gap > 0 && gap < 1) {
      current.end = next.start;
      // A still image simply remains visible; a video restarts from its first frame.
      current.loop = current.type === "video" ? gap : 0;
    }
  }
  return new Map<number, MaterialPlayback>(placements.map(({ index, start, end, loop }) => [index, { start, end, loop }]));
}
