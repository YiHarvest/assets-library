import { describe, expect, it, vi } from "vitest";
import { persistSceneBatch } from "@/server/services/scene-persistence";
import type {
  ObjectStorage,
  StoreFileInput,
  StoredObject,
} from "@/server/storage/object-storage";

function preparedBatch() {
  return {
    batchId: "d8c1a782-b75a-41e0-b53d-9091ac52c7b7",
    serviceTaskId: "a".repeat(32),
    parentPath: "/tmp/parent.mp4",
    durationSeconds: 2,
    workspacePath: "/tmp/batch",
    segments: [
      {
        index: 1,
        startSeconds: 0,
        endSeconds: 1,
        durationSeconds: 1,
        startFrame: 0,
        endFrame: 30,
        sizeBytes: 100,
        filename: "segment-001.mp4",
        downloadUrl: "/segments/1",
        absolutePath: "/tmp/segment-001.mp4",
        thumbnailAbsolutePath: "/tmp/thumbnail-001.jpg",
        thumbnailSizeBytes: 20,
      },
      {
        index: 2,
        startSeconds: 1,
        endSeconds: 2,
        durationSeconds: 1,
        startFrame: 30,
        endFrame: 60,
        sizeBytes: 120,
        filename: "segment-002.mp4",
        downloadUrl: "/segments/2",
        absolutePath: "/tmp/segment-002.mp4",
        thumbnailAbsolutePath: "/tmp/thumbnail-002.jpg",
        thumbnailSizeBytes: 20,
      },
    ],
  };
}

function fakeStorage() {
  const objects = new Map<string, StoredObject>();
  const storeFile = vi.fn(async (input: StoreFileInput) => {
    const object = {
      key: input.key,
      sizeBytes: input.filePath.includes("parent")
        ? 1_000
        : input.filePath.endsWith(".jpg")
          ? 20
          : 100,
    };
    objects.set(input.key, object);
    return object;
  });
  const deleteObject = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  const headObject = vi.fn(async (key: string) => {
    const object = objects.get(key);
    if (!object) throw new Error("not found");
    return object;
  });
  const getObject = vi.fn(async (key: string) => {
    const object = await headObject(key);
    return {
      ...object,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      contentLength: object.sizeBytes,
    };
  });
  const downloadToFile = vi.fn(async (key: string) => headObject(key));
  return {
    objects,
    storage: {
      storeFile,
      headObject,
      getObject,
      downloadToFile,
      deleteObject,
    } satisfies ObjectStorage,
    storeFile,
    deleteObject,
  };
}

describe("scene batch persistence", () => {
  it("commits MySQL only after every segment and thumbnail reach ZOS", async () => {
    const fake = fakeStorage();
    const commitDatabase = vi.fn(async () => {
      expect(fake.objects.size).toBe(4);
    });

    const result = await persistSceneBatch({
      batch: preparedBatch(),
      storage: fake.storage,
      commitDatabase,
      now: new Date("2026-08-12T00:00:00Z"),
    });

    expect(fake.storeFile).toHaveBeenCalledTimes(4);
    expect(commitDatabase).toHaveBeenCalledOnce();
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.thumbnailObject.key).toMatch(
      /\/thumbnails\/001-.+\.jpg$/,
    );
    expect(
      fake.storeFile.mock.calls.some(([input]) =>
        input.filePath.includes("parent"),
      ),
    ).toBe(false);
    expect(fake.deleteObject).not.toHaveBeenCalled();
  });

  it("compensates every uploaded object when the MySQL transaction fails", async () => {
    const fake = fakeStorage();

    await expect(
      persistSceneBatch({
        batch: preparedBatch(),
        storage: fake.storage,
        commitDatabase: async () => {
          throw new Error("mysql rollback");
        },
      }),
    ).rejects.toMatchObject({ code: "scene_persistence_failed" });

    expect(fake.deleteObject).toHaveBeenCalledTimes(4);
    expect(fake.objects.size).toBe(0);
  });

  it("removes a segment when its thumbnail upload fails", async () => {
    const fake = fakeStorage();
    fake.storeFile.mockImplementationOnce(async (input) => ({
      key: input.key,
      sizeBytes: 100,
    }));
    fake.storeFile.mockRejectedValueOnce(new Error("ZOS unavailable"));
    const commitDatabase = vi.fn();

    await expect(
      persistSceneBatch({
        batch: preparedBatch(),
        storage: fake.storage,
        commitDatabase,
        now: new Date("2026-08-12T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "scene_persistence_failed" });

    expect(commitDatabase).not.toHaveBeenCalled();
    expect(fake.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("compensates completed segment objects when a later upload fails", async () => {
    const fake = fakeStorage();
    const commitDatabase = vi.fn();
    fake.storeFile
      .mockImplementationOnce(async (input) => ({
        key: input.key,
        sizeBytes: 100,
      }))
      .mockImplementationOnce(async (input) => ({
        key: input.key,
        sizeBytes: 20,
      }))
      .mockRejectedValueOnce(new Error("thumbnail ZOS unavailable"));

    await expect(
      persistSceneBatch({
        batch: preparedBatch(),
        storage: fake.storage,
        commitDatabase,
        now: new Date("2026-08-12T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "scene_persistence_failed" });

    expect(commitDatabase).not.toHaveBeenCalled();
    expect(fake.deleteObject).toHaveBeenCalledTimes(2);
    const deletedKeys = new Set(
      fake.deleteObject.mock.calls.map(([key]) => key),
    );
    expect([...deletedKeys]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/segments\/001-.+\.mp4$/),
        expect.stringMatching(/\/thumbnails\/001-.+\.jpg$/),
      ]),
    );
  });
});
