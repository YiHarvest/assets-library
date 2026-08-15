import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVideoFrames,
  removeAnalysisWorkspace,
  seedAnalysisVideoFrames,
  storeVideoFrames,
} from "@/server/media/storage";

describe("media storage", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "asset-frame-storage-"),
    );
    process.env.MEDIA_ROOT = directory;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(directory, { recursive: true, force: true });
  });

  it("cleans staging and upload files when frame storage fails", async () => {
    const assetDirectory = path.join(directory, "asset-id");
    const firstUpload = path.join(directory, ".tmp", "frame-1.upload");
    const secondUpload = path.join(directory, ".tmp", "frame-2.upload");
    await fsPromises.mkdir(path.dirname(firstUpload), { recursive: true });
    await fsPromises.mkdir(assetDirectory, { recursive: true });
    await fsPromises.writeFile(path.join(assetDirectory, "original.mp4"), "video");
    await fsPromises.writeFile(firstUpload, "frame-1");
    await fsPromises.writeFile(secondUpload, "frame-2");
    const rename = fs.renameSync;
    let movedFrames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith(".upload")) {
        movedFrames += 1;
        if (movedFrames === 2) throw new Error("simulated storage failure");
      }
      return rename(source, target);
    });

    expect(() =>
      storeVideoFrames(
        path.join("asset-id", "original.mp4"),
        [
          { temporaryPath: firstUpload, timestampSeconds: 0.1 },
          { temporaryPath: secondUpload, timestampSeconds: 0.3 },
        ],
        { durationSeconds: 0.5, timestamps: [0.1, 0.3] },
      ),
    ).toThrowError("视频关键帧保存失败，请重试。");

    expect(fs.existsSync(firstUpload)).toBe(false);
    expect(fs.existsSync(secondUpload)).toBe(false);
    expect(fs.existsSync(path.join(assetDirectory, "frames"))).toBe(false);
    expect(
      (await fsPromises.readdir(assetDirectory)).some((name) =>
        name.startsWith("frames."),
      ),
    ).toBe(false);
  });

  it("atomically seeds and removes precomputed analysis frames", async () => {
    const source = path.join(directory, "prepared-frames");
    await fsPromises.mkdir(source, { recursive: true });
    await fsPromises.writeFile(path.join(source, "frame-01.jpg"), "frame");
    await fsPromises.writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({
        durationSeconds: 1,
        frames: [{ filename: "frame-01.jpg", timestampSeconds: 0.5 }],
      }),
    );

    const seeded = await seedAnalysisVideoFrames(
      "analysis-job",
      ".mp4",
      source,
      directory,
    );

    expect(fs.existsSync(path.join(seeded.workspace, "original.mp4"))).toBe(false);
    expect(readVideoFrames(seeded.relativePath, directory)).toEqual([
      expect.objectContaining({
        filename: "frame-01.jpg",
        timestampSeconds: 0.5,
      }),
    ]);
    await removeAnalysisWorkspace("analysis-job", directory);
    expect(fs.existsSync(seeded.workspace)).toBe(false);
  });
});
