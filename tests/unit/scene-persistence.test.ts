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
    resplitCount: 0,
    resplitDetails: [],
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
        analysisFramesDirectory: "/tmp/analysis-frames-001",
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
        analysisFramesDirectory: "/tmp/analysis-frames-002",
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
  it("limits concurrent ZOS uploads and preserves segment order", async () => {
    const fake = fakeStorage();
    const storeFile = fake.storeFile.getMockImplementation()!;
    let active = 0;
    let maximumActive = 0;
    fake.storeFile.mockImplementation(async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await storeFile(input);
      } finally {
        active -= 1;
      }
    });

    const result = await persistSceneBatch({
      batch: preparedBatch(),
      storage: fake.storage,
      concurrency: 2,
      commitDatabase: async () => undefined,
    });

    expect(maximumActive).toBe(2);
    expect(result.segments.map((segment) => segment.index)).toEqual([1, 2]);
  });

  it("commits MySQL only after the parent and every segment reach ZOS", async () => {
    const fake = fakeStorage();
    const commitDatabase = vi.fn(async () => {
      expect(fake.objects.size).toBe(5);
    });

    const result = await persistSceneBatch({
      batch: preparedBatch(),
      storage: fake.storage,
      commitDatabase,
      now: new Date("2026-08-12T00:00:00Z"),
    });

    expect(fake.storeFile).toHaveBeenCalledTimes(5);
    expect(commitDatabase).toHaveBeenCalledOnce();
    expect(result.parentObject.key).toBe(
      "assets/videos/2026/08/12/d8c1a782-b75a-41e0-b53d-9091ac52c7b7/parent.mp4",
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.thumbnailObject.key).toMatch(
      /\/thumbnails\/001-.+\.jpg$/,
    );
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

    expect(fake.deleteObject).toHaveBeenCalledTimes(5);
    expect(fake.objects.size).toBe(0);
  });

  it("removes the parent and completed segments when a later ZOS upload fails", async () => {
    const fake = fakeStorage();
    const storeFile = fake.storeFile.getMockImplementation()!;
    fake.storeFile.mockImplementation(async (input) => {
      if (input.filePath.endsWith("segment-001.mp4")) {
        throw new Error("ZOS unavailable");
      }
      return storeFile(input);
    });
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
    // 并发上传中其他对象可能先成功；所有实际成功对象都必须被补偿删除。
    expect(fake.deleteObject).toHaveBeenCalledTimes(3);
    expect(fake.objects.size).toBe(0);
  });

  it("compensates the segment when its thumbnail upload fails", async () => {
    const fake = fakeStorage();
    const commitDatabase = vi.fn();
    const storeFile = fake.storeFile.getMockImplementation()!;
    fake.storeFile.mockImplementation(async (input) => {
      if (input.filePath.endsWith("thumbnail-001.jpg")) {
        throw new Error("thumbnail ZOS unavailable");
      }
      return storeFile(input);
    });

    await expect(
      persistSceneBatch({
        batch: preparedBatch(),
        storage: fake.storage,
        commitDatabase,
        now: new Date("2026-08-12T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "scene_persistence_failed" });

    expect(commitDatabase).not.toHaveBeenCalled();
    expect(fake.deleteObject).toHaveBeenCalledTimes(4);
    expect(fake.objects.size).toBe(0);
    const deletedKeys = new Set(
      fake.deleteObject.mock.calls.map(([key]) => key),
    );
    expect(deletedKeys).toContain(
      "assets/videos/2026/08/12/d8c1a782-b75a-41e0-b53d-9091ac52c7b7/parent.mp4",
    );
    expect([...deletedKeys]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/segments\/001-.+\.mp4$/),
      ]),
    );
  });
});
