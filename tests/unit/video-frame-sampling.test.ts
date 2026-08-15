import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractVideoFramesToDirectory } from "@/server/media/video-frames";
import { videoFrameTimestamps } from "@/shared/video-frames";

const execFileAsync = promisify(execFile);

describe("video frame sampling", () => {
  it.each([
    [0.8, [0.4]],
    [2, [0.5, 1.5]],
    [2.4, [0.4, 1.2, 2]],
    [4, [0.667, 2, 3.333]],
    [5, [0.833, 2.5, 4.167]],
    [9.9, [1.65, 4.95, 8.25]],
    [10, [1, 3, 5, 7, 9]],
    [20, [2, 6, 10, 14, 18]],
  ])("samples %s seconds at quantile midpoints", (duration, expected) => {
    expect(videoFrameTimestamps(duration)).toEqual(expected);
  });

  it("rejects invalid durations", () => {
    expect(() => videoFrameTimestamps(0)).toThrow();
    expect(() => videoFrameTimestamps(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("downscales extracted JPEG frames to at most 640px wide", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assets-frames-scale-"));
    const videoPath = path.join(root, "source.mp4");
    const frameDirectory = path.join(root, "frames");
    try {
      await execFileAsync("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:size=1280x640:duration=0.2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        videoPath,
      ]);

      await extractVideoFramesToDirectory(videoPath, frameDirectory);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "V:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path.join(frameDirectory, "frame-01.jpg"),
      ]);

      expect(stdout.trim()).toBe("640,320");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
