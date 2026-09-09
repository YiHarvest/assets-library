import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaResponse } from "@/server/media/response";

const fakes = vi.hoisted(() => ({
  getAsset: vi.fn(), getObject: vi.fn(), download: vi.fn(),
}));
vi.mock("@/server/repositories/assets", () => ({ getAssetRecord: fakes.getAsset }));
vi.mock("@/server/repositories/user-media", () => ({ getAssetThumbnailObject: vi.fn() }));
vi.mock("@/server/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: fakes.getObject }) }) }) },
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
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x160:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file]);
    source = await fs.readFile(file);
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
    const range = await mediaResponse(assetId, new Request(url, { headers: { range: "bytes=10-99" } }));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 10-99/${bytes.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(10, 100));
    expect(await fs.readFile(path.join(root, "original.mp4"))).toEqual(source);
    expect((await fs.readdir(path.join(root, ".staging"))).filter(name => name.startsWith("recall-work-"))).toEqual([]);
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
