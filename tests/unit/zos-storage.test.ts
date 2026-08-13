import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZosObjectStorage } from "@/server/storage/zos";

function streamFor(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type FakeS3Command =
  | PutObjectCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | GetObjectCommand
  | DeleteObjectCommand;
type FakeS3Response = Record<string, unknown>;

function fakeS3() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string; etag: string }
  >();
  const send = vi.fn<
    (command: FakeS3Command) => Promise<FakeS3Response>
  >(async (command) => {
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      objects.set(key, {
        bytes: new Uint8Array(command.input.ContentLength ?? 0).fill(7),
        contentType: command.input.ContentType,
        etag: '"put-etag"',
      });
      return { ETag: '"put-etag"' };
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (!object) throw new Error("not found");
      return {
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        ETag: object.etag,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (!object) throw new Error("not found");
      let start = 0;
      let end = object.bytes.byteLength - 1;
      if (command.input.Range) {
        const match = command.input.Range.match(/^bytes=(\d+)-(\d*)$/)!;
        start = Number.parseInt(match[1]!, 10);
        if (match[2]) end = Number.parseInt(match[2], 10);
      }
      const bytes = object.bytes.slice(start, end + 1);
      return {
        Body: { transformToWebStream: () => streamFor(bytes) },
        ContentLength: bytes.byteLength,
        ContentRange: command.input.Range
          ? `bytes ${start}-${end}/${object.bytes.byteLength}`
          : undefined,
        ContentType: object.contentType,
        ETag: object.etag,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key!);
      return {};
    }
    throw new Error("unknown command");
  });
  return { objects, send, client: { send } as unknown as S3Client };
}

describe("ZOS object storage adapter", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "asset-zos-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("checks bucket access without requiring a probe object", async () => {
    const fake = fakeS3();
    const storage = new ZosObjectStorage({
      endpoint: "https://zos.example.test",
      bucket: "archives",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      client: fake.client,
    });

    await expect(storage.checkHealth()).resolves.toBeUndefined();
    expect(fake.send).toHaveBeenCalledWith(
      expect.any(HeadBucketCommand),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(fake.objects.size).toBe(0);
  });

  it("verifies uploaded object size with HEAD and supports byte ranges", async () => {
    const fake = fakeS3();
    const storage = new ZosObjectStorage({
      endpoint: "https://zos.example.test",
      bucket: "archives",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      client: fake.client,
      publicBaseUrl: "https://cdn.example.test",
    });
    const filePath = path.join(directory, "segment.mp4");
    await fs.writeFile(filePath, Buffer.from("0123456789"));

    const stored = await storage.storeFile({
      key: "assets/videos/segment.mp4",
      filePath,
      contentType: "video/mp4",
    });
    expect(stored).toEqual({
      key: "assets/videos/segment.mp4",
      sizeBytes: 10,
      etag: "put-etag",
      url: "https://cdn.example.test/assets/videos/segment.mp4",
    });
    expect(fake.send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(true);

    const ranged = await storage.getObject(stored.key, { start: 2, end: 5 });
    expect(ranged).toMatchObject({
      sizeBytes: 10,
      contentLength: 4,
      contentRange: "bytes 2-5/10",
      contentType: "video/mp4",
    });
    const bytes = new Uint8Array(await new Response(ranged.body).arrayBuffer());
    expect([...bytes]).toEqual([7, 7, 7, 7]);
  });

  it("isolates every newly stored object below the configured prefix", async () => {
    const fake = fakeS3();
    const storage = new ZosObjectStorage({
      endpoint: "https://zos.example.test",
      bucket: "archives",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      objectPrefix: "/test_assets/",
      client: fake.client,
      publicBaseUrl: "https://cdn.example.test",
    });
    const filePath = path.join(directory, "image.jpg");
    await fs.writeFile(filePath, "image");

    const stored = await storage.storeFile({
      key: "assets/images/image.jpg",
      filePath,
      contentType: "image/jpeg",
    });

    expect(stored.key).toBe("test_assets/assets/images/image.jpg");
    expect(stored.url).toBe(
      "https://cdn.example.test/test_assets/assets/images/image.jpg",
    );
    expect(fake.objects.has(stored.key)).toBe(true);

    await storage.deleteObject(stored.key);
    expect(fake.objects.has(stored.key)).toBe(false);
  });

  it("downloads through a temporary file and verifies the complete size", async () => {
    const fake = fakeS3();
    fake.objects.set("assets/video.mp4", {
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "video/mp4",
      etag: '"etag"',
    });
    const storage = new ZosObjectStorage({
      endpoint: "https://zos.example.test",
      bucket: "archives",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      client: fake.client,
    });
    const destination = path.join(directory, "nested", "video.mp4");

    await expect(storage.downloadToFile("assets/video.mp4", destination)).resolves.toMatchObject({
      sizeBytes: 4,
    });
    expect([...await fs.readFile(destination)]).toEqual([1, 2, 3, 4]);
    await expect(fs.stat(`${destination}.download`)).rejects.toThrow();
  });

  it("deletes a possibly-created object when post-upload verification fails", async () => {
    const fake = fakeS3();
    const originalSend = fake.send.getMockImplementation()!;
    fake.send.mockImplementation(async (command) => {
      const response = await originalSend(command);
      if (command instanceof HeadObjectCommand) {
        return { ...response, ContentLength: 999 };
      }
      return response;
    });
    const storage = new ZosObjectStorage({
      endpoint: "https://zos.example.test",
      bucket: "archives",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      client: fake.client,
    });
    const filePath = path.join(directory, "segment.mp4");
    await fs.writeFile(filePath, "small");

    await expect(
      storage.storeFile({
        key: "assets/segment.mp4",
        filePath,
        contentType: "video/mp4",
      }),
    ).rejects.toThrow("上传后大小不一致");
    expect(fake.objects.has("assets/segment.mp4")).toBe(false);
    expect(fake.send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
  });
});
