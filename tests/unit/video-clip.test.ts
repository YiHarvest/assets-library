import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaResponse } from "@/server/media/response";

const fakes = vi.hoisted(() => ({
  getAsset: vi.fn(), getDetail: vi.fn(), getObject: vi.fn(), download: vi.fn(),
}));
vi.mock("@/server/repositories/assets", () => ({ getAssetRecord: fakes.getAsset, getAssetDetail: fakes.getDetail }));
vi.mock("@/server/repositories/user-media", () => ({ getAssetThumbnailObject: vi.fn() }));
vi.mock("@/server/db", () => ({
  db: { select: () => ({ from: () => ({ where: (condition: unknown) => ({ limit: () => fakes.getObject(condition) }) }) }) },
}));
vi.mock("@/server/storage/zos", () => ({
  createZosObjectStorage: () => ({ downloadToFile: fakes.download }),
}));

const exec = promisify(execFile);
const assetId = "00000000-0000-4000-8000-000000000001";
const url = `https://assets.example/api/v1/media/${assetId}?user_id=759&clip_ms=1480`;
let fixtureRoot: string;
let source: Buffer;
let root: string;
let object: { id: string; provider: string; status: string; localPath: string; objectKey: string; sizeBytes: number; updatedAt: Date };

async function probe(file: string) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", file]);
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: Array<{ codec_name: string; codec_type: string; width?: number; height?: number }>;
  };
}

describe("matched video clipping through the media response", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recall-clip-fixture-"));
    const file = path.join(fixtureRoot, "source.mp4");
    await exec("ffmpeg", ["-nostdin", "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:size=96x160:rate=30:duration=2",
      "-f", "lavfi", "-i", "color=c=blue:size=96x160:rate=30:duration=6.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-t", "8.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
    source = await fs.readFile(file);
    for (const [name, color, size, rate, audio] of [["short-a", "red", "96x160", "30", true], ["short-b", "blue", "160x90", "20", false]] as const) {
      await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:size=${size}:rate=${rate}:duration=1`,
        ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"] : []), "-t", "1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac"] : []), path.join(fixtureRoot, `${name}.mp4`)]);
      await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", path.join(fixtureRoot, `${name}.mp4`), "-t", "0.5",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path.join(fixtureRoot, `tiny-${name}.mp4`)]);
    }
  }, 20_000);
  afterAll(async () => fs.rm(fixtureRoot, { recursive: true, force: true }));

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-clip-test-"));
    vi.stubEnv("MEDIA_ROOT", root);
    await fs.writeFile(path.join(root, "original.mp4"), source);
    object = { id: "source-object", provider: "local", status: "persisted", localPath: "original.mp4",
      objectKey: "assets/original.mp4", sizeBytes: source.length, updatedAt: new Date("2026-09-09T00:00:00Z") };
    fakes.getObject.mockImplementation(async () => [object]);
    fakes.getAsset.mockResolvedValue({ id: assetId, mediaObjectId: object.id, mediaType: "video", mimeType: "video/mp4",
      originalFilename: "original.mp4", processingStatus: "completed", reviewStatus: "published", deletedAt: null });
    fakes.download.mockImplementation(async (_key: string, destination: string) => fs.writeFile(destination, source));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function shortVideoUrl(durationMs = 1000) {
    const secondId = "00000000-0000-4000-8000-000000000002";
    const objects = [object, { ...object, id: "second-object", provider: "zos", objectKey: "short-b.mp4" }];
    objects[0].localPath = "short-a.mp4";
    const prefix = durationMs === 500 ? "tiny-" : "";
    await fs.copyFile(path.join(fixtureRoot, `${prefix}short-a.mp4`), path.join(root, "short-a.mp4"));
    fakes.getObject.mockImplementation(async condition => {
      const id = new MySqlDialect().sqlToQuery(condition).params[0];
      return objects.filter(item => item.id === id);
    });
    fakes.getAsset.mockImplementation(async id => ({ id, mediaObjectId: id === assetId ? object.id : "second-object", mediaType: "video",
      mimeType: "video/mp4", processingStatus: "completed", reviewStatus: "published", deletedAt: null }));
    fakes.getDetail.mockImplementation(async () => ({ mediaType: "video", segmentStartMs: 5000, segmentEndMs: 5000 + durationMs }));
    fakes.download.mockImplementation(async (_key: string, destination: string) => fs.copyFile(path.join(fixtureRoot, `${prefix}short-b.mp4`), destination));
    const combined = new URL(url);
    combined.searchParams.set("concat", Buffer.from(JSON.stringify([{ assetId, userId: "759" }, { assetId: secondId, userId: null }])).toString("base64url"));
    return { combined, secondId, objects };
  }

  it.each([null, 1480, 2700, 5000])("joins mixed sizes, frame rates and audio tracks for target %s without looping", async target => {
    const { combined, secondId } = await shortVideoUrl();
    if (target === null) combined.searchParams.delete("clip_ms");
    else combined.searchParams.set("clip_ms", String(target));
    const response = await mediaResponse(assetId, new Request(combined));
    const bytes = Buffer.from(await response.arrayBuffer());
    const output = path.join(root, "joined.mp4");
    await fs.writeFile(output, bytes);
    const info = await probe(output);
    const expected = Math.min(target ?? 2000, 2000) / 1000;
    expect(Number(info.format.duration)).toBeLessThanOrEqual(expected + 0.001);
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(expected - 0.04);
    expect(info.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 96, height: 160 }),
      expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
    ]));
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
    for (const [time, channel] of (expected > 1.8 ? [[0.4, 0], [1.8, 2]] : [[0.4, 0]])) {
      const frame = path.join(root, `joined-${time}.png`);
      await exec("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", frame]);
      const center = await sharp(frame).extract({ left: 40, top: 70, width: 16, height: 16 }).toBuffer();
      const { channels } = await sharp(center).stats();
      expect(channels[channel].mean).toBeGreaterThan(240);
    }
    expect(fakes.getDetail).toHaveBeenCalledWith(assetId, { userId: "759" });
    expect(fakes.getDetail).toHaveBeenCalledWith(secondId, {});
    const range = await mediaResponse(assetId, new Request(combined, { headers: { range: "bytes=10-99" } }));
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(10, 100));
    expect(fakes.download).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(root, "short-a.mp4"))).toEqual(await fs.readFile(path.join(fixtureRoot, "short-a.mp4")));
    expect((await fs.readdir(path.join(root, ".staging"))).filter(name => name.startsWith("recall-work-"))).toEqual([]);
  });

  it("revalidates every component before serving a cached combination", async () => {
    const { combined, objects } = await shortVideoUrl();
    await (await mediaResponse(assetId, new Request(combined))).arrayBuffer();
    objects[1].status = "deleted";
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 404 });
    objects[1].status = "persisted";
    fakes.getDetail.mockRejectedValueOnce(new Error("scope denied"));
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toThrow("scope denied");
    const original = fakes.getAsset.getMockImplementation()!;
    fakes.getAsset.mockImplementation(async id => ({ ...await original(id), ...(id !== assetId ? { reviewStatus: "deleted" } : {}) }));
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 404 });
    expect(fakes.download).toHaveBeenCalledTimes(1);
  });

  it("rejects insufficient totals and repeated components before downloading", async () => {
    const { combined } = await shortVideoUrl();
    fakes.getDetail.mockResolvedValue({ mediaType: "video", segmentStartMs: 0, segmentEndMs: 499 });
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 400 });
    combined.searchParams.set("concat", Buffer.from(JSON.stringify([{ assetId, userId: "759" }, { assetId, userId: "759" }])).toString("base64url"));
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 400 });
    expect(fakes.download).not.toHaveBeenCalled();
  });

  it("serves a one-second combination at the default minimum and revalidates a higher configured minimum", async () => {
    const { combined } = await shortVideoUrl(500);
    const response = await mediaResponse(assetId, new Request(combined));
    expect(response.status).toBe(200);
    const file = path.join(root, "one-second.mp4");
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    expect(Number((await probe(file)).format.duration)).toBeCloseTo(1, 1);
    vi.stubEnv("SEGMENT_MATCH_MIN_VIDEO_DURATION_MS", "2000");
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 400 });
  });

  it("checks actual combined duration against configuration even if database metadata overstates it", async () => {
    const { combined } = await shortVideoUrl(500);
    vi.stubEnv("SEGMENT_MATCH_MIN_VIDEO_DURATION_MS", "1500");
    fakes.getDetail.mockResolvedValue({ mediaType: "video", segmentStartMs: 0, segmentEndMs: 1000 });
    await expect(mediaResponse(assetId, new Request(combined))).rejects.toMatchObject({ status: 400, message: "短视频组合实际时长不足 1.5 秒。" });
  });

  it("cuts 8.5 seconds to the target slot, preserves audio and serves byte ranges from the cached MP4", async () => {
    const response = await mediaResponse(assetId, new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    const clip = path.join(root, "downloaded.mp4");
    await fs.writeFile(clip, bytes);
    const info = await probe(clip);
    expect(Number(info.format.duration)).toBeLessThanOrEqual(1.48);
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(1.44);
    expect(info.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_name: "h264", codec_type: "video", width: 96, height: 160 }),
      expect.objectContaining({ codec_name: "aac", codec_type: "audio" }),
    ]));
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", clip, "-f", "null", "-"]);
    // 输入前 2 秒为红色，其后为蓝色：应截取素材开头，而不是文本的 6.12 秒位置。
    const frame = path.join(root, "last-frame.png");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-ss", "1.4", "-i", clip, "-frames:v", "1", frame]);
    const colors = await sharp(frame).stats();
    expect(colors.channels[0].mean).toBeGreaterThan(240);
    expect(colors.channels[2].mean).toBeLessThan(15);
    const range = await mediaResponse(assetId, new Request(url, { headers: { range: "bytes=10-99" } }));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 10-99/${bytes.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(10, 100));
    expect(await fs.readFile(path.join(root, "original.mp4"))).toEqual(source);
    expect((await fs.readdir(path.join(root, ".staging"))).filter(name => name.startsWith("recall-work-"))).toEqual([]);
  });

  it.each(["png", "jpeg", "webp"] as const)("returns a three-second static video for a recalled %s image", async format => {
    const image = await sharp({ create: { width: 97, height: 161, channels: 3, background: "#ff0000" } }).toFormat(format).toBuffer();
    object.localPath = `original.${format}`;
    object.sizeBytes = image.length;
    await fs.writeFile(path.join(root, object.localPath), image);
    fakes.getAsset.mockResolvedValue({ ...(await fakes.getAsset()), mediaType: "image", mimeType: `image/${format}`, originalFilename: object.localPath });
    if (format === "webp") {
      object.provider = "zos";
      fakes.download.mockImplementation(async (_key: string, destination: string) => fs.writeFile(destination, image));
    }
    // 即使文本只有 1.48 秒，静态图片视频仍固定为 3 秒，不再套用视频裁剪时长。
    const imageUrl = `${url}&still_ms=3000`;
    const response = await mediaResponse(assetId, new Request(imageUrl));
    expect(response.headers.get("content-type")).toBe("video/mp4");
    const bytes = Buffer.from(await response.arrayBuffer());
    const output = path.join(root, "still-video.mp4");
    await fs.writeFile(output, bytes);
    const info = await probe(output);
    expect(Number(info.format.duration)).toBe(3);
    expect(info.streams).toEqual([expect.objectContaining({ codec_name: "h264", codec_type: "video", width: 98, height: 162 })]);
    for (const time of [0, 2.9]) {
      const frame = path.join(root, `frame-${time}.png`);
      await exec("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", frame]);
      const colors = await sharp(frame).stats();
      expect(colors.channels[0].mean).toBeGreaterThan(240);
      expect(colors.channels[2].mean).toBeLessThan(15);
    }
    const range = await mediaResponse(assetId, new Request(imageUrl, { headers: { range: "bytes=10-99" } }));
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(10, 100));
    expect(await fs.readFile(path.join(root, object.localPath))).toEqual(image);
    if (format !== "webp") {
      const original = await mediaResponse(assetId, new Request(url.replace("&clip_ms=1480", "")));
      expect(original.headers.get("content-type")).toBe(`image/${format}`);
      expect(Buffer.from(await original.arrayBuffer())).toEqual(image);
    }
  });

  it.each([8500, 9000])("returns identical source bytes for an equal or longer target of %i ms", async duration => {
    const response = await mediaResponse(assetId, new Request(url.replace("1480", String(duration))));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    expect(await fs.readdir(path.join(root, ".staging"))).toEqual([]);
  });

  it("returns the original file when the URL has no clipping instruction", async () => {
    const response = await mediaResponse(assetId, new Request(url.replace("&clip_ms=1480", "")));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    expect(await fs.readdir(root)).toEqual(["original.mp4"]);
  });

  it("downloads ZOS media once for concurrent requests and regenerates an expired cache", async () => {
    object.provider = "zos";
    const responses = await Promise.all([mediaResponse(assetId, new Request(url)), mediaResponse(assetId, new Request(url))]);
    const [first, second] = await Promise.all(responses.map(async response => Buffer.from(await response.arrayBuffer())));
    expect(first).toEqual(second);
    expect(fakes.download).toHaveBeenCalledTimes(1);
    await fs.rm(path.join(root, ".staging"), { recursive: true });
    const regenerated = await mediaResponse(assetId, new Request(url));
    expect(Buffer.from(await regenerated.arrayBuffer())).toEqual(first);
    expect(fakes.download).toHaveBeenCalledTimes(2);
  });

  it("does not expose a partial clip after failure and can retry the same URL", async () => {
    object.provider = "zos";
    fakes.download.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(mediaResponse(assetId, new Request(url))).rejects.toThrow("storage unavailable");
    expect(await fs.readdir(path.join(root, ".staging"))).toEqual([]);
    const response = await mediaResponse(assetId, new Request(url));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("checks source availability even if a clipped file is already cached", async () => {
    const response = await mediaResponse(assetId, new Request(url));
    await response.arrayBuffer();
    object.status = "deleted";
    await expect(mediaResponse(assetId, new Request(url))).rejects.toMatchObject({ status: 404 });
    fakes.getAsset.mockResolvedValue(null);
    await expect(mediaResponse(assetId, new Request(url))).rejects.toMatchObject({ status: 404 });
  });

  it.each(["0", "-1", "NaN", "Infinity", "1.5", "9007199254740992"])("rejects invalid clip duration %s before reading the source", async duration => {
    object.provider = "zos";
    await expect(mediaResponse(assetId, new Request(url.replace("1480", duration)))).rejects.toMatchObject({ status: 400 });
    expect(fakes.download).not.toHaveBeenCalled();
  });
});
