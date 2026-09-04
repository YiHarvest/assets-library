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

  async copyObject(input: { sourceKey: string; destinationKey: string }) {
    const source = this.required(input.sourceKey);
    this.objects.set(input.destinationKey, {
      bytes: Buffer.from(source.bytes),
      contentType: source.contentType,
    });
    return {
      key: input.destinationKey,
      sizeBytes: source.bytes.byteLength,
      etag: "test-etag",
    };
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

const analyzeMock = vi.fn<MultimodalAnalyzer["analyze"]>(async (input) => {
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
  });
const analyzer: MultimodalAnalyzer = { analyze: analyzeMock };

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
    analyzeMock.mockClear();
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

  async function createAndSeal(
    filename: string,
    bytes: Buffer,
    userId: string | null = "user-pipeline",
  ) {
    const service = new api.DefaultApiV1Service();
    const created = await service.createUploadTask({
      user_id: userId,
      callback_url: null,
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
    expect(status.items[0]!.private_asset_ids).toHaveLength(1);
    expect(status.items[0]!.public_asset_ids).toHaveLength(1);
    expect(status.items[0]!.private_asset_ids[0]).not.toBe(
      status.items[0]!.public_asset_ids[0],
    );
    const [privateAsset] = await database.db
      .select()
      .from(schema.privateAssets)
      .where(eq(schema.privateAssets.id, status.items[0]!.private_asset_ids[0]!));
    const [publicAsset] = await database.db
      .select()
      .from(schema.publicAssets)
      .where(eq(schema.publicAssets.id, status.items[0]!.public_asset_ids[0]!));
    const analysisRows = await database.db.select().from(schema.analysisResults);
    const objects = await database.db
      .select()
      .from(schema.mediaObjects);
    expect(privateAsset).toMatchObject({
      mediaType: "image",
      processingStatus: "completed",
      reviewStatus: "pending_review",
      userId: "user-pipeline",
      publicAssetId: publicAsset!.id,
    });
    expect(publicAsset).toMatchObject({
      mediaType: "image",
      processingStatus: "completed",
      reviewStatus: "pending_review",
      uploaderUserId: "user-pipeline",
    });
    expect(privateAsset!.mediaObjectId).not.toBe(publicAsset!.mediaObjectId);
    expect(analysisRows).toHaveLength(2);
    expect(analysisRows.every((row) => row.resultJson.kind === "image")).toBe(true);
    expect(objects).toHaveLength(2);
    expect(objects.every((object) => object.provider === "zos" && object.status === "persisted")).toBe(true);
    expect([...storage.objects.values()].every((object) => object.bytes.equals(image))).toBe(true);
    expect(analyzeMock).toHaveBeenCalledTimes(1);
    await service.publishAsset(privateAsset!.id, {
      user_id: "user-pipeline",
      callback_url: null,
    });
    await processUntilIdle();
    await expect(
      database.db
        .select({ reviewStatus: schema.privateAssets.reviewStatus })
        .from(schema.privateAssets)
        .where(eq(schema.privateAssets.id, privateAsset!.id)),
    ).resolves.toEqual([{ reviewStatus: "published" }]);
    await expect(
      database.db
        .select({ reviewStatus: schema.publicAssets.reviewStatus })
        .from(schema.publicAssets)
        .where(eq(schema.publicAssets.id, publicAsset!.id)),
    ).resolves.toEqual([{ reviewStatus: "pending_review" }]);
    await expect(
      fs.stat(path.join(process.env.MEDIA_ROOT!, ".staging", taskId)),
    ).rejects.toThrow();
  }, 30_000);

  test("公共直传只创建公共记录和一套对象，分析后仍待审核", async () => {
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#335577" },
    })
      .png()
      .toBuffer();
    const { service, taskId } = await createAndSeal("public.png", image, null);

    await processUntilIdle();
    const status = await service.getTask(taskId);
    expect(status.items[0]).toMatchObject({
      private_asset_ids: [],
      public_asset_ids: [expect.any(String)],
    });
    await expect(database.db.select().from(schema.privateAssets)).resolves.toHaveLength(0);
    await expect(database.db.select().from(schema.publicAssets)).resolves.toEqual([
      expect.objectContaining({
        uploaderUserId: null,
        processingStatus: "completed",
        reviewStatus: "pending_review",
      }),
    ]);
    await expect(database.db.select().from(schema.mediaObjects)).resolves.toHaveLength(1);
    expect(storage.objects.size).toBe(1);
    expect(analyzeMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("父视频分镜为多个子素材，父视频不进素材表，每个切片独立关键帧分析", async () => {
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
    expect(status.items[0]!.private_asset_ids).toHaveLength(2);
    expect(status.items[0]!.public_asset_ids).toHaveLength(2);

    const privateAssetRows = await database.db
      .select()
      .from(schema.privateAssets)
      .where(eq(schema.privateAssets.taskId, taskId));
    const publicAssetRows = await database.db
      .select()
      .from(schema.publicAssets)
      .where(eq(schema.publicAssets.taskId, taskId));
    const sourceRows = await database.db
      .select()
      .from(schema.videoSources)
      .where(eq(schema.videoSources.taskId, taskId));
    const analysisRows = await database.db.select().from(schema.analysisResults);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]?.generatedSegmentCount).toBe(2);
    expect(sourceRows[0]!.publicMediaObjectId).not.toBe(sourceRows[0]!.privateMediaObjectId);
    expect(privateAssetRows).toHaveLength(2);
    expect(publicAssetRows).toHaveLength(2);
    expect(privateAssetRows.map((row) => row.segmentIndex).sort()).toEqual([1, 2]);
    expect(publicAssetRows.map((row) => row.segmentIndex).sort()).toEqual([1, 2]);
    expect(privateAssetRows.every((row) => row.videoSourceId === sourceRows[0]!.id)).toBe(true);
    expect(publicAssetRows.every((row) => row.videoSourceId === sourceRows[0]!.id)).toBe(true);
    expect(privateAssetRows.every((row) => row.processingStatus === "completed")).toBe(true);
    expect(privateAssetRows.every((row) => row.reviewStatus === "pending_review")).toBe(true);
    expect(publicAssetRows.every((row) => row.reviewStatus === "pending_review")).toBe(true);
    expect(analysisRows).toHaveLength(4);
    expect(analysisRows.every((row) => row.resultJson.kind === "video")).toBe(true);
    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(framePreparation).not.toHaveBeenCalled();
    expect(storage.downloads).toEqual([]);
    expect(storage.objects.size).toBe(10); // 公私各 1 个父对象 + 2 个切片 + 2 张首帧
    for (const asset of privateAssetRows) {
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
      privateAssetRows[0]!.id,
      new Request(`http://localhost/api/v1/media/${privateAssetRows[0]!.id}/thumbnail`),
      storage,
    );
    expect(thumbnailGet.status).toBe(200);
    expect(thumbnailGet.headers.get("content-type")).toBe("image/jpeg");
    const thumbnailBytes = new Uint8Array(await thumbnailGet.arrayBuffer());
    expect([...thumbnailBytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const thumbnailRange = await thumbnailResponse(
      privateAssetRows[0]!.id,
      new Request(`http://localhost/api/v1/media/${privateAssetRows[0]!.id}/thumbnail`, {
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

    // 公私副本独立删除，各自只回收本侧切片视频与首帧。
    const deletedAsset = privateAssetRows[0]!;
    const pairedPublicAsset = publicAssetRows.find(
      (asset) => asset.id === deletedAsset.publicAssetId,
    )!;
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
    expect(
      await database.db
        .select()
        .from(schema.publicAssets)
        .where(eq(schema.publicAssets.id, pairedPublicAsset.id)),
    ).toHaveLength(1);
    await service.deleteAsset(pairedPublicAsset.id, {
      user_id: null,
      callback_url: null,
    });
    await processUntilIdle(client, framePreparation);
    expect(storage.objects.has(deletedMainKey)).toBe(false);
    expect(storage.objects.has(deletedThumbnailKey)).toBe(false);
    expect(
      await database.db
        .select()
        .from(schema.privateAssets)
        .where(eq(schema.privateAssets.id, deletedAsset.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, deletedAsset.thumbnailMediaObjectId!)),
    ).toHaveLength(0);
    expect(storage.objects.size).toBe(6);
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
      private_asset_ids: [expect.any(String)],
      public_asset_ids: [expect.any(String)],
    });
    const privateAssets = await database.db.select().from(schema.privateAssets);
    const publicAssets = await database.db.select().from(schema.publicAssets);
    const sources = await database.db.select().from(schema.videoSources);
    const objects = await database.db.select().from(schema.mediaObjects);
    expect(privateAssets).toHaveLength(1);
    expect(publicAssets).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(objects).toHaveLength(6); // 公私各自的父视频、切分子视频和缩略图
    expect(privateAssets[0]!.sizeBytes).toBeLessThanOrEqual(limit);
    expect(publicAssets[0]!.sizeBytes).toBeLessThanOrEqual(limit);
    expect(storage.objects.size).toBe(6);
    // 二次切分不下载远端超限切片，只下载/校验本地子切片
    expect(
      fake.request.mock.calls.some(([input]) =>
        String(input).includes("/segments/1"),
      ),
    ).toBe(false);
  }, 30_000);
});
