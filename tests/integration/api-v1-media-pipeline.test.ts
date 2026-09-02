import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { MultimodalAnalyzer } from "@/server/model/analyzer";
import type {
  ObjectByteRange,
  ObjectStorage,
  StoreFileInput,
} from "@/server/storage/object-storage";
import {
  bindIntegrationDatabaseEnvironment,
  truncateIntegrationTables,
} from "../helpers/integration-database";

const execFileAsync = promisify(execFile);
const semanticSearchEnabledMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/server/search/chroma", () => ({
  semanticSearchEnabled: semanticSearchEnabledMock,
  indexAnalysis: vi.fn(async () => undefined),
  searchAnalysis: vi.fn(async () => new Map()),
  deleteAnalysis: vi.fn(async () => undefined),
}));

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mysqlPipeline = testDatabaseUrl ? describe : describe.skip;
type DatabaseModule = typeof import("@/server/db");
type Repository = typeof import("@/server/repositories/assets");
type Schema = typeof import("@/server/db/schema");
type Processing = typeof import("@/server/services/processing");
type ApiService = typeof import("@/server/api/v1/default-service");
type SceneClient = import("@/server/scene/client").SceneDetectClient;

function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** CI 中的 ZOS 替身保存真实媒体字节，并提供与生产适配器相同的下载语义。 */
class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly downloads: string[] = [];

  async storeFile(input: StoreFileInput) {
    const bytes = await fs.readFile(input.filePath);
    this.objects.set(input.key, { bytes, contentType: input.contentType });
    return { key: input.key, sizeBytes: bytes.byteLength, etag: "test-etag" };
  }

  async headObject(key: string) {
    const object = this.required(key);
    return {
      key,
      sizeBytes: object.bytes.byteLength,
      contentType: object.contentType,
      etag: "test-etag",
    };
  }

  async getObject(key: string, range?: ObjectByteRange) {
    const object = this.required(key);
    const start = range?.start ?? 0;
    const end = Math.min(
      range?.end ?? object.bytes.byteLength - 1,
      object.bytes.byteLength - 1,
    );
    const bytes = object.bytes.subarray(start, end + 1);
    return {
      ...(await this.headObject(key)),
      body: body(bytes),
      contentLength: bytes.byteLength,
      ...(range
        ? { contentRange: `bytes ${start}-${end}/${object.bytes.byteLength}` }
        : {}),
    };
  }

  async downloadToFile(key: string, destinationPath: string) {
    this.downloads.push(key);
    const object = this.required(key);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, object.bytes);
    return this.headObject(key);
  }

  async deleteObject(key: string) {
    this.objects.delete(key);
  }

  private required(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`object not found: ${key}`);
    return object;
  }
}

async function createVideo(filePath: string, color: string, duration = 0.4) {
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64:d=${duration}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    filePath,
  ]);
}

function splitManifest(
  taskId: string,
  segments: Array<{ bytes: Buffer; duration: number }>,
) {
  let cursor = 0;
  return {
    taskId,
    originalFilename: "parent.mp4",
    durationSeconds: segments.reduce((sum, segment) => sum + segment.duration, 0),
    sceneCount: segments.length,
    segments: segments.map((segment, offset) => {
      const startSeconds = cursor;
      cursor += segment.duration;
      return {
        index: offset + 1,
        startSeconds,
        endSeconds: cursor,
        durationSeconds: segment.duration,
        startFrame: offset * 12,
        endFrame: (offset + 1) * 12,
        sizeBytes: segment.bytes.byteLength,
        filename: `segment-${String(offset + 1).padStart(3, "0")}.mp4`,
        downloadUrl: `/api/v1/videos/split/${taskId}/segments/${offset + 1}`,
      };
    }),
  };
}

function fakeSceneClient(
  manifest: ReturnType<typeof splitManifest>,
  segmentBytes: Buffer[],
) {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/videos/split" && init?.method === "POST") {
      return Response.json(manifest);
    }
    const segment = url.pathname.match(/\/segments\/(\d+)$/);
    if (segment) {
      const bytes = segmentBytes[Number(segment[1]) - 1]!;
      return new Response(bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);
    }
    if (
      url.pathname === `/api/v1/videos/split/${manifest.taskId}` &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
  return { request };
}

const analyzer: MultimodalAnalyzer = {
  async analyze(input) {
    return input.mediaType === "image"
      ? {
          result: {
            kind: "image" as const,
            description: "测试图片分析完成",
            tags: {
              scene: ["测试场景"],
              object: ["图片"],
              person: [],
              style: ["简洁"],
              color_composition: ["蓝色"],
            },
            ocr: { text: null, unavailableReason: "无文字" },
          },
          model: { protocol: "openai_chat_completions" as const, name: "fake-vlm" },
        }
      : {
          result: {
            kind: "video" as const,
            description: `切片 ${input.assetId} 关键帧分析完成`,
            topics: ["测试视频"],
            tags: { scene: ["彩色画面"], person: [], form: ["短视频"] },
            visualSegments: [{ startSeconds: 0, endSeconds: 0.4, summary: "彩色画面" }],
            keyMoments: [{ seconds: 0, summary: "首帧" }],
            timeline: [{ startSeconds: 0, endSeconds: 0.4, summary: "彩色画面" }],
          },
          model: { protocol: "openai_chat_completions" as const, name: "fake-vlm" },
        };
  },
};

mysqlPipeline("API v1 完整媒体管线", () => {
  let temporaryRoot: string;
  let database: DatabaseModule;
  let repository: Repository;
  let schema: Schema;
  let processing: Processing;
  let api: ApiService;
  let storage: MemoryObjectStorage;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    // 必须先同步模式库名，确保后续动态导入的数据库单例仍绑定测试库。
    bindIntegrationDatabaseEnvironment(testDatabaseUrl);
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assets-pipeline-"));
    process.env.MEDIA_ROOT = path.join(temporaryRoot, "media");
    process.env.SCENE_DETECT_WORKSPACE_ROOT = path.join(temporaryRoot, "scenes");
    process.env.SCENE_DETECT_ENABLED = "true";
    process.env.SCENE_SEGMENT_MAX_BYTES = String(10 * 1024 * 1024);
    process.env.EMBEDDING_BASE_URL = "";
    process.env.EMBEDDING_MODEL = "";
    process.env.ZOS_BUCKET = "test-bucket";

    const { initializeDatabase } = await import("@/server/db/migrations");
    const connection = await initializeDatabase({
      url: testDatabaseUrl,
      sslCaPath: process.env.DATABASE_SSL_CA_PATH || undefined,
      poolSize: 4,
    });
    // 从此处开始的源码导入都共用同一个测试库单例。
    database = await import("@/server/db");
    repository = await import("@/server/repositories/assets");
    schema = await import("@/server/db/schema");
    processing = await import("@/server/services/processing");
    api = await import("@/server/api/v1/default-service");
    await connection.pool.end();
  }, 30_000);

  beforeEach(async () => {
    storage = new MemoryObjectStorage();
    await truncateIntegrationTables(database.pool);
    await fs.rm(process.env.MEDIA_ROOT!, { recursive: true, force: true });
    await fs.rm(process.env.SCENE_DETECT_WORKSPACE_ROOT!, {
      recursive: true,
      force: true,
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // 断言失败时仍回收数据库和临时媒体，避免测试夹具泄漏到后续 WebUI。
    if (database?.pool) await truncateIntegrationTables(database.pool);
    if (process.env.MEDIA_ROOT) {
      await fs.rm(process.env.MEDIA_ROOT, { recursive: true, force: true });
    }
    if (process.env.SCENE_DETECT_WORKSPACE_ROOT) {
      await fs.rm(process.env.SCENE_DETECT_WORKSPACE_ROOT, {
        recursive: true,
        force: true,
      });
    }
  });

  afterAll(async () => {
    try {
      if (database?.pool) await truncateIntegrationTables(database.pool);
    } finally {
      if (database?.pool) await database.pool.end();
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  });

  async function createAndSeal(filename: string, bytes: Buffer) {
    const service = new api.DefaultApiV1Service();
    const created = await service.createUploadTask({
      user_id: "user-pipeline",
      callback_url: null,
      auto_publish: true,
      items: [{ filename, size_bytes: bytes.byteLength, content_type: null }],
    });
    const itemId = created.items[0]!.item_id;
    const received = await service.receiveUploadItem({
      taskId: created.task_id,
      itemId,
      body: body(bytes),
      contentLength: bytes.byteLength,
      contentType: null,
    });
    expect(received).toMatchObject({
      phase: "waiting_for_seal",
      received_bytes: bytes.byteLength,
    });
    const sealed = await service.sealUploadTask(created.task_id);
    expect(sealed).toMatchObject({ status: "running", phase: "validating" });
    return { service, taskId: created.task_id, itemId };
  }

  async function processUntilIdle(
    sceneClient?: SceneClient,
    videoFramePreparer: Parameters<typeof processing.processJob>[3] = async () => undefined,
  ) {
    while (true) {
      const job = await repository.claimNextJob("pipeline-test");
      if (!job) return;
      await processing.processJob(
        job,
        analyzer,
        undefined,
        videoFramePreparer,
        { storage, sceneClient },
      );
    }
  }

  test("图片三步上传后持久化到对象存储和 MySQL，并完成分析", async () => {
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#3388cc" },
    })
      .png()
      .toBuffer();
    const { service, taskId, itemId } = await createAndSeal("sample.png", image);

    await processUntilIdle();
    const status = await service.getTask(taskId);
    expect(status).toMatchObject({
      status: "done",
      phase: "finished",
      progress_percent: 100,
      done_items: 1,
      failed_items: 0,
    });
    expect(status.items[0]).toMatchObject({
      item_id: itemId,
      media_type: "image",
      status: "done",
      phase: "finished",
    });
    expect(status.items[0]!.asset_ids).toHaveLength(1);

    const [assetRow] = await database.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, status.items[0]!.asset_ids[0]!));
    const [analysis] = await database.db
      .select()
      .from(schema.analysisResults)
      .where(eq(schema.analysisResults.assetId, assetRow!.id));
    const [object] = await database.db
      .select()
      .from(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, assetRow!.mediaObjectId!));
    expect(assetRow).toMatchObject({
      mediaType: "image",
      processingStatus: "completed",
      reviewStatus: "published",
      userId: "user-pipeline",
    });
    expect(analysis?.resultJson).toMatchObject({
      kind: "image",
      description: "测试图片分析完成",
    });
    expect(object).toMatchObject({ provider: "zos", status: "persisted" });
    expect(storage.objects.get(object!.objectKey)?.bytes).toEqual(image);
    await expect(
      fs.stat(path.join(process.env.MEDIA_ROOT!, ".staging", taskId)),
    ).rejects.toThrow();
  }, 30_000);

  test("父视频分镜为多个子素材，父视频不进 assets，每个切片独立关键帧分析", async () => {
    const mediaDirectory = path.join(temporaryRoot, "fixtures");
    await fs.mkdir(mediaDirectory, { recursive: true });
    const paths = ["parent.mp4", "red.mp4", "green.mp4"].map((name) =>
      path.join(mediaDirectory, name),
    );
    await Promise.all([
      createVideo(paths[0]!, "blue", 0.8),
      createVideo(paths[1]!, "red"),
      createVideo(paths[2]!, "green"),
    ]);
    const [parentBytes, ...segments] = await Promise.all(
      paths.map((filePath) => fs.readFile(filePath)),
    );
    const manifest = splitManifest(
      "a".repeat(32),
      segments.map((bytes) => ({ bytes, duration: 0.4 })),
    );
    const fake = fakeSceneClient(manifest, segments);
    const { SceneDetectClient } = await import("@/server/scene/client");
    const client = new SceneDetectClient({
      baseUrl: "https://your.com",
      timeoutMs: 10_000,
      fetchImplementation: fake.request,
    });
    const { service, taskId, itemId } = await createAndSeal(
      "parent.mp4",
      parentBytes,
    );
    const framePreparation = vi.fn(async () => undefined);

    await processUntilIdle(client, framePreparation);
    const status = await service.getTask(taskId);
    expect(status).toMatchObject({
      status: "done",
      phase: "finished",
      total_items: 1,
      done_items: 1,
      failed_items: 0,
    });
    expect(status.items[0]).toMatchObject({
      item_id: itemId,
      media_type: "video",
      status: "done",
      phase: "finished",
    });
    expect(status.items[0]!.asset_ids).toHaveLength(2);

    const assetRows = await database.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.taskId, taskId));
    const sourceRows = await database.db
      .select()
      .from(schema.videoSources)
      .where(eq(schema.videoSources.taskId, taskId));
    const analysisRows = await database.db.select().from(schema.analysisResults);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]?.generatedSegmentCount).toBe(2);
    expect(assetRows).toHaveLength(2);
    expect(assetRows.map((row) => row.segmentIndex).sort()).toEqual([1, 2]);
    expect(assetRows.every((row) => row.sizeBytes <= 10 * 1024 * 1024)).toBe(true);
    expect(assetRows.every((row) => row.videoSourceId === sourceRows[0]!.id)).toBe(true);
    expect(assetRows.every((row) => row.thumbnailMediaObjectId)).toBe(true);
    expect(assetRows.some((row) => row.id === sourceRows[0]!.id)).toBe(false);
    expect(assetRows.every((row) => row.processingStatus === "completed")).toBe(true);
    expect(analysisRows).toHaveLength(2);
    expect(analysisRows.every((row) => row.resultJson.kind === "video")).toBe(true);
    expect(framePreparation).not.toHaveBeenCalled();
    expect(storage.downloads).toEqual([]);
    expect(storage.objects.size).toBe(5); // 1 个父对象 + 2 个切片 + 2 张首帧
    for (const asset of assetRows) {
      const [thumbnail] = await database.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, asset.thumbnailMediaObjectId!));
      expect(thumbnail).toMatchObject({ mimeType: "image/jpeg", status: "persisted" });
      const bytes = storage.objects.get(thumbnail!.objectKey)!.bytes;
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    }
    const { thumbnailResponse } = await import("@/server/media/response");
    const thumbnailGet = await thumbnailResponse(
      assetRows[0]!.id,
      new Request(`http://localhost/api/v1/media/${assetRows[0]!.id}/thumbnail`),
      storage,
    );
    expect(thumbnailGet.status).toBe(200);
    expect(thumbnailGet.headers.get("content-type")).toBe("image/jpeg");
    const thumbnailBytes = new Uint8Array(await thumbnailGet.arrayBuffer());
    expect([...thumbnailBytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const thumbnailRange = await thumbnailResponse(
      assetRows[0]!.id,
      new Request(`http://localhost/api/v1/media/${assetRows[0]!.id}/thumbnail`, {
        headers: { range: "bytes=0-9" },
      }),
      storage,
    );
    expect(thumbnailRange.status).toBe(206);
    expect(thumbnailRange.headers.get("content-range")).toBe(
      `bytes 0-9/${thumbnailBytes.byteLength}`,
    );
    expect((await thumbnailRange.arrayBuffer()).byteLength).toBe(10);
    expect(fake.request).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: `/api/v1/videos/split/${manifest.taskId}`,
      }),
      expect.objectContaining({ method: "DELETE" }),
    );

    // 用户删除先转公共；公共硬删必须同步回收该切片视频与首帧，兄弟切片和父视频保留。
    const deletedAsset = assetRows[0]!;
    const deletedMainKey = (
      await database.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, deletedAsset.mediaObjectId!))
    )[0]!.objectKey;
    const deletedThumbnailKey = (
      await database.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, deletedAsset.thumbnailMediaObjectId!))
    )[0]!.objectKey;
    await service.deleteAsset(deletedAsset.id, {
      user_id: "user-pipeline",
      callback_url: null,
    });
    await processUntilIdle(client, framePreparation);
    await service.deleteAsset(deletedAsset.id, {
      user_id: null,
      callback_url: null,
    });
    await processUntilIdle(client, framePreparation);
    expect(storage.objects.has(deletedMainKey)).toBe(false);
    expect(storage.objects.has(deletedThumbnailKey)).toBe(false);
    expect(
      await database.db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, deletedAsset.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, deletedAsset.thumbnailMediaObjectId!)),
    ).toHaveLength(0);
    expect(storage.objects.size).toBe(3);
  }, 45_000);

  test("任一切片超过 10 MiB 时本地二次切分后正常入库，不下载远端切片", async () => {
    const parentPath = path.join(temporaryRoot, "oversize-parent.mp4");
    await createVideo(parentPath, "black", 0.4);
    const parentBytes = await fs.readFile(parentPath);
    const limit = 10 * 1024 * 1024;
    const advertised = Buffer.alloc(limit + 1);
    const manifest = splitManifest("b".repeat(32), [
      { bytes: advertised, duration: 0.4 },
    ]);
    const fake = fakeSceneClient(manifest, [advertised]);
    const { SceneDetectClient } = await import("@/server/scene/client");
    const client = new SceneDetectClient({
      baseUrl: "https://your.com",
      timeoutMs: 10_000,
      fetchImplementation: fake.request,
    });
    const { service, taskId } = await createAndSeal(
      "oversize-parent.mp4",
      parentBytes,
    );

    await processUntilIdle(client);
    const status = await service.getTask(taskId);
    expect(status).toMatchObject({
      status: "done",
      phase: "finished",
      done_items: 1,
      failed_items: 0,
    });
    expect(status.items[0]).toMatchObject({
      status: "done",
      asset_ids: [expect.any(String)],
    });
    const assets = await database.db.select().from(schema.assets);
    const sources = await database.db.select().from(schema.videoSources);
    const objects = await database.db.select().from(schema.mediaObjects);
    expect(assets).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(objects).toHaveLength(3); // 父视频 + 切分子视频 + 缩略图
    expect(assets[0]!.sizeBytes).toBeLessThanOrEqual(limit);
    expect(storage.objects.size).toBe(3);
    // 二次切分不下载远端超限切片，只下载/校验本地子切片
    expect(
      fake.request.mock.calls.some(([input]) =>
        String(input).includes("/segments/1"),
      ),
    ).toBe(false);
  }, 30_000);
});
