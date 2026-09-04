import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateMediaFile } from "@/server/media/validate";

const execFileAsync = promisify(execFile);

async function probeVideo(filePath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=format_name:stream=codec_name,pix_fmt",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(stdout) as {
    format: { format_name: string };
    streams: Array<{ codec_name: string; pix_fmt: string }>;
  };
}

describe("media validation", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "asset-media-"));
    process.env.MAX_IMAGE_BYTES = String(20 * 1024 * 1024);
    process.env.MAX_VIDEO_BYTES = String(200 * 1024 * 1024);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("accepts a valid PNG image", async () => {
    const filePath = path.join(directory, "image.png");
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "#00aacc",
      },
    })
      .png()
      .toFile(filePath);
    const stat = await fs.stat(filePath);
    await expect(
      validateMediaFile(filePath, "image.png"),
    ).resolves.toMatchObject({ mediaType: "image", mimeType: "image/png" });
    expect(stat.size).toBe((await fs.stat(filePath)).size);
  });

  it("accepts a progressive JPEG with metadata", async () => {
    const filePath = path.join(directory, "downloaded.jpeg");
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: "#d9a066",
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ progressive: true })
      .toFile(filePath);
    await expect(
      validateMediaFile(filePath, "downloaded.jpeg"),
    ).resolves.toMatchObject({
      mediaType: "image",
      mimeType: "image/jpeg",
      extension: ".jpeg",
    });
  });

  it("converts a renamed image into the requested extension format", async () => {
    const filePath = path.join(directory, "renamed.jpeg");
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "#00aacc",
      },
    })
      .png()
      .toFile(filePath);
    const validated = await validateMediaFile(filePath, "renamed.jpeg");

    expect(validated).toMatchObject({
      mediaType: "image",
      mimeType: "image/jpeg",
      extension: ".jpeg",
    });
    expect((await sharp(filePath).metadata()).format).toBe("jpeg");
    expect((await fs.stat(filePath)).size).toBe(validated.sizeBytes);
  });

  it("transcodes a non-H.264 video renamed to MP4 into H.264 MP4", async () => {
    const filePath = path.join(directory, "renamed.mp4");
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=16x16:d=0.2",
      "-c:v",
      "mpeg4",
      "-q:v",
      "5",
      "-f",
      "avi",
      "-y",
      filePath,
    ]);
    const validated = await validateMediaFile(filePath, "renamed.mp4");

    const probe = await probeVideo(filePath);
    expect(validated).toMatchObject({
      mediaType: "video",
      mimeType: "video/mp4",
      extension: ".mp4",
    });
    expect(probe.format.format_name.split(",")).toContain("mp4");
    expect(probe.streams[0]).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
    });
    expect((await fs.stat(filePath)).size).toBe(validated.sizeBytes);
  }, 15_000);

  it("normalizes full-range video to browser-compatible limited range", async () => {
    const filePath = path.join(directory, "full-range.mp4");
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=16x16:d=0.2",
      "-vf",
      "scale=in_range=tv:out_range=pc",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuvj420p",
      "-color_range",
      "pc",
      "-y",
      filePath,
    ]);
    expect((await probeVideo(filePath)).streams[0]?.pix_fmt).toBe("yuvj420p");

    await validateMediaFile(filePath, "full-range.mp4");

    expect((await probeVideo(filePath)).streams[0]?.pix_fmt).toBe("yuv420p");
  }, 15_000);

  it("remuxes a 3GP container renamed to MP4 into an actual MP4 brand", async () => {
    const filePath = path.join(directory, "renamed-3gp.mp4");
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=16x16:d=0.2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "3gp",
      "-y",
      filePath,
    ]);

    await validateMediaFile(filePath, "renamed-3gp.mp4");

    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format_tags=major_brand",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    expect(stdout.trim()).toBe("isom");
  }, 15_000);

  it("rejects a forged MP4 marker and an image renamed to MP4", async () => {
    const markerPath = path.join(directory, "marker.mp4");
    const imagePath = path.join(directory, "image.mp4");
    await fs.writeFile(
      markerPath,
      Buffer.from("\0\0\0\u0018ftypisom____avc1", "latin1"),
    );
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png()
      .toFile(imagePath);

    await expect(
      validateMediaFile(markerPath, "marker.mp4"),
    ).rejects.toMatchObject({ code: "corrupt_file" });
    await expect(
      validateMediaFile(imagePath, "image.mp4"),
    ).rejects.toMatchObject({ code: "corrupt_file" });
  });

  it("reports unreadable image content as corrupt", async () => {
    const filePath = path.join(directory, "fake.png");
    await fs.writeFile(filePath, "not an image");
    await expect(
      validateMediaFile(filePath, "fake.png"),
    ).rejects.toMatchObject({ code: "corrupt_file" });
  });

  for (const target of [
    { extension: ".jpg", format: "jpeg" },
    { extension: ".png", format: "png" },
    { extension: ".webp", format: "webp" },
  ] as const) {
    it(`fully decodes ${target.format} before accepting it`, async () => {
      const full = await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 4,
          background: { r: 22, g: 136, b: 204, alpha: 0.6 },
        },
      })
        [target.format]()
        .toBuffer();

      for (const retainedRatio of [0.9, 0.5]) {
        const filePath = path.join(
          directory,
          `truncated-${retainedRatio}${target.extension}`,
        );
        await fs.writeFile(
          filePath,
          full.subarray(0, Math.floor(full.length * retainedRatio)),
        );

        await expect(
          validateMediaFile(filePath, path.basename(filePath)),
        ).rejects.toMatchObject({ code: "corrupt_file" });
      }
    });
  }
});
