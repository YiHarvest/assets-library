import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  RequestMethod,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AssetsController } from "../src/modules/assets/assets.controller";
import { HealthController } from "../src/modules/health/health.controller";
import { ObservabilityController, eventSchema } from "../src/modules/observability/observability.controller";
import { StorageController } from "../src/modules/storage/storage.controller";
import { TasksController } from "../src/modules/tasks/tasks.controller";
import { TemporaryFilesController } from "../src/modules/temporary-files/temporary-files.controller";
import { UploadsController } from "../src/modules/uploads/uploads.controller";
import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { ApiExceptionFilter } from "../src/common/api-exception.filter";
import {
  assetDetailQuerySchema,
  assetListSchema,
  assetSearchSchema,
  completeUploadSchema,
  createUploadSchema,
  deleteAssetSchema,
  publishAssetSchema,
  retryAssetSchema,
  storageUsageSchema,
  taskQuerySchema,
  updateAssetSchema,
} from "../src/contracts/schemas";
import { ApiService, decodeCursor } from "../src/services/api.service";
import { publicAssetAnalysis } from "../src/services/asset-presentation";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

type ControllerClass = abstract new (...args: never[]) => object;

function route(
  controller: ControllerClass,
  method: string,
) {
  const handler = (controller.prototype as Record<string, object>)[method];
  return {
    controller: Reflect.getMetadata(PATH_METADATA, controller),
    path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler),
    status: Reflect.getMetadata(HTTP_CODE_METADATA, handler),
  };
}

function invalid(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) {
  assert.equal(schema.safeParse(value).success, false);
}

function apiServiceWith(database: unknown, zos: unknown = {}) {
  return Object.assign(Object.create(ApiService.prototype) as ApiService, {
    database,
    zos,
    config: {
      TASK_HISTORY_RETENTION_HOURS: 24,
      MAX_IMAGE_BYTES: 20 * 1024 * 1024,
      MAX_VIDEO_BYTES: 200 * 1024 * 1024,
    },
    chroma: { enabled: false },
  });
}

test("全部公开业务接口保持静态路由、HTTP方法和成功状态码", () => {
  assert.deepEqual(route(UploadsController, "create"), {
    controller: "uploads", path: "/", method: RequestMethod.POST, status: undefined,
  });
  assert.deepEqual(route(UploadsController, "complete"), {
    controller: "uploads", path: "complete", method: RequestMethod.POST, status: 202,
  });
  assert.deepEqual(route(TemporaryFilesController, "upload"), {
    controller: "temporary-files", path: "/", method: RequestMethod.POST, status: 200,
  });
  assert.deepEqual(route(TasksController, "get"), {
    controller: "tasks", path: "/", method: RequestMethod.GET, status: undefined,
  });
  assert.deepEqual(route(AssetsController, "list"), {
    controller: "assets", path: "list", method: RequestMethod.POST, status: 200,
  });
  assert.deepEqual(route(AssetsController, "search"), {
    controller: "assets", path: "search", method: RequestMethod.POST, status: 200,
  });
  assert.deepEqual(route(AssetsController, "detail"), {
    controller: "assets", path: "detail", method: RequestMethod.GET, status: undefined,
  });
  assert.deepEqual(route(AssetsController, "update"), {
    controller: "assets", path: "update", method: RequestMethod.PATCH, status: 202,
  });
  assert.deepEqual(route(AssetsController, "publish"), {
    controller: "assets", path: "publish", method: RequestMethod.POST, status: 202,
  });
  assert.deepEqual(route(AssetsController, "retry"), {
    controller: "assets", path: "retry", method: RequestMethod.POST, status: 202,
  });
  assert.deepEqual(route(AssetsController, "delete"), {
    controller: "assets", path: "delete", method: RequestMethod.DELETE, status: 202,
  });
  assert.deepEqual(route(StorageController, "usage"), {
    controller: "storage", path: "usage", method: RequestMethod.POST, status: 200,
  });
  assert.deepEqual(route(ObservabilityController, "event"), {
    controller: "observability", path: "events", method: RequestMethod.POST, status: 204,
  });
  assert.deepEqual(route(HealthController, "getHealth"), {
    controller: "health", path: "/", method: RequestMethod.GET, status: undefined,
  });
});

test("永久上传契约接受最多9图或单个视频，并规范化公共user_id", () => {
  const publicUpload = createUploadSchema.parse({ files: [{ media_type: "image" }] });
  assert.equal(publicUpload.user_id, null);
  assert.equal(publicUpload.auto_publish, false);
  assert.equal(createUploadSchema.safeParse({
    user_id: " user-1 ", auto_publish: true,
    callback_url: "https://callback.example/job",
    files: Array.from({ length: 9 }, () => ({ media_type: "image" })),
  }).success, true);
  assert.equal(createUploadSchema.safeParse({ files: [{ media_type: "video", file_name: "a.mp4" }] }).success, true);
  invalid(createUploadSchema, { files: [] });
  invalid(createUploadSchema, { files: Array.from({ length: 10 }, () => ({ media_type: "image" })) });
  invalid(createUploadSchema, { files: [{ media_type: "image" }, { media_type: "video" }] });
  invalid(createUploadSchema, { files: [{ media_type: "video" }, { media_type: "video" }] });
  invalid(createUploadSchema, { files: [{ media_type: "gif" }] });
  invalid(createUploadSchema, { files: [{ media_type: "image", extra: true }] });
  invalid(createUploadSchema, { files: [{ media_type: "image" }], callback_url: "ftp://callback.example" });
});

test("complete、详情和变更接口严格校验UUID、user_id、callback及多余字段", () => {
  assert.deepEqual(completeUploadSchema.parse({ task_id: UUID_A }), { task_id: UUID_A });
  invalid(completeUploadSchema, { task_id: "not-a-uuid" });
  invalid(completeUploadSchema, { task_id: UUID_A, file_id: UUID_B });
  assert.deepEqual(assetDetailQuerySchema.parse({ file_id: UUID_A }), { file_id: UUID_A });
  invalid(assetDetailQuerySchema, {});

  assert.equal(updateAssetSchema.safeParse({ file_id: UUID_A, user_id: "user-1", tags: [] }).success, true);
  invalid(updateAssetSchema, { file_id: UUID_A, user_id: "user-1" });
  invalid(updateAssetSchema, { file_id: UUID_A, user_id: "", description: "x" });
  invalid(updateAssetSchema, { file_id: UUID_A, user_id: "user-1", unknown: true });

  assert.equal(publishAssetSchema.parse({ file_id: UUID_A }).user_id, null);
  assert.equal(publishAssetSchema.parse({ file_id: UUID_A, user_id: "" }).user_id, null);
  assert.equal(deleteAssetSchema.parse({ file_id: UUID_A, user_id: null }).user_id, null);
  invalid(publishAssetSchema, { file_id: "bad" });
  invalid(deleteAssetSchema, { file_id: UUID_A, callback_url: "javascript:alert(1)" });
});

test("重试目标必须在file_id和video_source_id中二选一", () => {
  assert.equal(retryAssetSchema.safeParse({ file_id: UUID_A }).success, true);
  assert.equal(retryAssetSchema.safeParse({ video_source_id: UUID_B, user_id: "user-1" }).success, true);
  invalid(retryAssetSchema, {});
  invalid(retryAssetSchema, { file_id: UUID_A, video_source_id: UUID_B });
});

test("素材列表支持图片、视频、全部，并严格执行三种用户范围互斥", () => {
  const defaults = assetListSchema.parse({});
  assert.deepEqual(defaults.phases, ["published"]);
  assert.equal(defaults.limit, 20);
  assert.equal(defaults.user_id, null);
  for (const mediaType of ["image", "video", "all", null, undefined]) {
    assert.equal(assetListSchema.safeParse({ media_type: mediaType }).success, true);
  }
  assert.equal(assetListSchema.parse({ media_type: "all" }).media_type, undefined);
  invalid(assetListSchema, { user_id: "user-1", include_all_users: true });
  invalid(assetListSchema, { user_id: "user-1", exclude_user_id: "user-2" });
  invalid(assetListSchema, { include_all_users: true, exclude_user_id: "user-2" });
  invalid(assetListSchema, { phases: [] });
  invalid(assetListSchema, { limit: 101 });
});

test("素材搜索要求描述或标签，并支持all/any/exclude三类标签条件", () => {
  invalid(assetSearchSchema, {});
  assert.equal(assetSearchSchema.safeParse({ description: "日落" }).success, true);
  assert.equal(assetSearchSchema.safeParse({ tags: { all: ["海边", "日落"] } }).success, true);
  assert.equal(assetSearchSchema.safeParse({ tags: { any: ["海边"] } }).success, true);
  assert.equal(assetSearchSchema.safeParse({ tags: { exclude: ["室内"] } }).success, true);
  invalid(assetSearchSchema, { tags: { all: [] } });
  invalid(assetSearchSchema, { tags: { any: ["海边"], category: "scene" } });
  assert.equal(assetSearchSchema.parse({ description: "日落", media_type: "all" }).media_type, undefined);
});

test("任务查询严格区分单任务与待入库列表，公共范围统一为null", () => {
  assert.equal(taskQuerySchema.safeParse({ task_id: UUID_A }).success, true);
  const pending = taskQuerySchema.parse({ view: "pending", user_id: "" });
  assert.equal(pending.user_id, null);
  assert.equal(pending.limit, 20);
  invalid(taskQuerySchema, {});
  invalid(taskQuerySchema, { task_id: UUID_A, view: "pending" });
  invalid(taskQuerySchema, { task_id: UUID_A, user_id: "user-1" });
  invalid(taskQuerySchema, { task_id: UUID_A, cursor: "cursor" });
  invalid(taskQuerySchema, { view: "all" });
});

test("存储统计区分公共与个人范围且拒绝额外字段", () => {
  assert.equal(storageUsageSchema.parse({}).user_id, null);
  assert.equal(storageUsageSchema.parse({ user_id: "user-1" }).user_id, "user-1");
  invalid(storageUsageSchema, { user_id: "user-1", include_all_users: true });
});

test("前端操作日志仅接受白名单metadata和受限状态", () => {
  const event = {
    operation_id: "op-1", event: "upload", step: "request",
    duration_ms: 10, status: "done", metadata: { task_id: UUID_A, file_count: 2 },
  };
  assert.equal(eventSchema.safeParse(event).success, true);
  invalid(eventSchema, { ...event, status: "success" });
  invalid(eventSchema, { ...event, duration_ms: -1 });
  invalid(eventSchema, { ...event, metadata: { upload_url: "secret" } });
});

test("前端操作日志超过进程速率限制时返回429且不接受本次事件", () => {
  const controller = Object.create(ObservabilityController.prototype) as ObservabilityController;
  const state = controller as unknown as {
    config: { OBSERVABILITY_EVENTS_PER_MINUTE: number; SLOW_OPERATION_MS: number };
    eventsInWindow: number;
    windowStartedAt: number;
  };
  state.config = { OBSERVABILITY_EVENTS_PER_MINUTE: 1, SLOW_OPERATION_MS: 1_000 };
  state.eventsInWindow = 1;
  state.windowStartedAt = Date.now();
  assert.throws(
    () => controller.event({
      operation_id: "op-rate-limit",
      event: "upload",
      step: "request",
      duration_ms: 0,
      status: "done",
    }),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
  assert.equal(state.eventsInWindow, 1);
});

test("详情分析契约保留图片OCR及视频四类旧版展示数据", () => {
  assert.deepEqual(publicAssetAnalysis("image", {
    ocr: { text: "海边咖啡馆\n营业时间 09:00", unavailable_reason: "ignored" },
  }), {
    ocr: { text: "海边咖啡馆\n营业时间 09:00", unavailable_reason: null },
  });
  assert.deepEqual(publicAssetAnalysis("image", undefined), {
    ocr: { text: null, unavailable_reason: "无可识别文本" },
  });

  const video = {
    topics: ["海滨旅行"],
    visual_segments: [{ start_seconds: 0, end_seconds: 2, summary: "海面" }],
    key_moments: [{ seconds: 1, summary: "人物入镜" }],
    timeline: [{ start_seconds: 0, end_seconds: 4, summary: "完整镜头" }],
  };
  assert.deepEqual(publicAssetAnalysis("video", video), video);
  assert.deepEqual(publicAssetAnalysis("video", undefined), {
    topics: [], visual_segments: [], key_moments: [], timeline: [],
  });
});

test("ZodValidationPipe稳定返回400 invalid_request及字段详情", () => {
  const pipe = new ZodValidationPipe(completeUploadSchema);
  assert.throws(
    () => pipe.transform({ task_id: "bad" }),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(error.getStatus(), 400);
      const response = error.getResponse() as { error: { code: string; details: Array<{ field: string }> } };
      assert.equal(response.error.code, "invalid_request");
      assert.equal(response.error.details[0]?.field, "task_id");
      return true;
    },
  );
});

test("全局异常过滤器稳定映射常见错误状态且隐藏未知500详情", () => {
  const filter = new ApiExceptionFilter();
  const run = (error: unknown) => {
    let status = 0;
    let body: unknown;
    const response = {
      status(value: number) { status = value; return this; },
      json(value: unknown) { body = value; return this; },
    };
    filter.catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
    return { status, body };
  };

  assert.deepEqual(run(new ForbiddenException("禁止访问")), {
    status: 403, body: { error: { code: "forbidden", message: "禁止访问" } },
  });
  assert.deepEqual(run(new NotFoundException("资源不存在")), {
    status: 404, body: { error: { code: "not_found", message: "资源不存在" } },
  });
  assert.deepEqual(run(new ConflictException("状态冲突")), {
    status: 409, body: { error: { code: "conflict", message: "状态冲突" } },
  });
  assert.deepEqual(run(new PayloadTooLargeException("文件过大")), {
    status: 413, body: { error: { code: "file_too_large", message: "文件过大" } },
  });
  assert.deepEqual(run({ type: "entity.too.large", status: 413 }), {
    status: 413, body: { error: { code: "file_too_large", message: "请求体过大。" } },
  });
  assert.deepEqual(run(new ServiceUnavailableException("依赖不可用")), {
    status: 503, body: { error: { code: "service_unavailable", message: "依赖不可用" } },
  });
  assert.deepEqual(run(new Error("数据库密码等内部信息")), {
    status: 500, body: { error: { code: "internal_error", message: "系统处理失败，请稍后重试。" } },
  });
});

test("列表和任务的非法cursor统一返回400", () => {
  assert.throws(
    () => decodeCursor("not-a-cursor"),
    (error: unknown) => error instanceof BadRequestException && error.getStatus() === 400,
  );
});

test("健康检查仅在全部依赖up时返回200，否则明确返回503", async () => {
  let status = 200;
  const response = { status(value: number) { status = value; return this; } };
  const up = new HealthController({ check: async () => ({ status: "up" }) } as never);
  assert.deepEqual(await up.getHealth(response as never), { status: "up" });
  assert.equal(status, 200);

  const degraded = new HealthController({
    check: async () => ({ status: "degraded", dependencies: { scene: "down" } }),
  } as never);
  assert.deepEqual(await degraded.getHealth(response as never), {
    status: "degraded", dependencies: { scene: "down" },
  });
  assert.equal(status, 503);
});

test("控制器把合法请求分派到唯一服务方法，任务查询不会混淆模式", async () => {
  const calls: Array<[string, unknown]> = [];
  const service = new Proxy({}, {
    get(_target, key: string) {
      return async (...args: unknown[]) => {
        calls.push([key, args]);
        return { method: key };
      };
    },
  }) as ApiService;
  const uploads = new UploadsController(service);
  const assets = new AssetsController(service);
  const tasks = new TasksController(service);
  const storage = new StorageController(service);

  await uploads.create({ files: [{ media_type: "image" }] });
  await uploads.complete({ task_id: UUID_A });
  await assets.list({});
  await assets.search({ description: "海边" });
  await assets.detail({ file_id: UUID_A });
  await assets.update({ file_id: UUID_A, user_id: "user-1", description: "描述" });
  await assets.publish({ file_id: UUID_A });
  await assets.retry({ file_id: UUID_A });
  await assets.delete({ file_id: UUID_A });
  await tasks.get({ task_id: UUID_A });
  await tasks.get({ view: "pending", user_id: "user-1", limit: "20" });
  await storage.usage({});

  assert.deepEqual(calls.map(([name]) => name), [
    "createUpload", "completeUpload", "listAssets", "searchAssets", "assetDetail",
    "queueMutation", "queueMutation", "queueMutation", "queueMutation",
    "getTask", "listPending", "storageUsage",
  ]);
  assert.deepEqual(calls.slice(5, 9).map(([, args]) => (args as unknown[])[0]), [
    "update", "publish", "retry", "delete",
  ]);
});

test("重复complete在任务已离开uploading后直接返回现有任务，不创建新处理链", async () => {
  const existing = { id: UUID_A, status: "pending_review", phase: "pending_review" };
  const database = {
    db: { query: { tasks: { findFirst: async () => existing } } },
  };
  const service = apiServiceWith(database);
  let taskReads = 0;
  service.getTask = async (taskId: string) => {
    taskReads += 1;
    return { task_id: taskId, status: "pending_review", phase: "pending_review" } as never;
  };
  const result = await service.completeUpload(UUID_A);
  assert.equal(taskReads, 1);
  assert.equal(result.status, "pending_review");
});

test("并发重复complete只有一个调用者能认领，失败认领者只读取当前任务", async () => {
  let transactionCalls = 0;
  const database = {
    db: {
      query: { tasks: { findFirst: async () => ({ id: UUID_A, status: "queued", phase: "uploading" }) } },
      update: () => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) }),
      transaction: async () => { transactionCalls += 1; },
    },
  };
  const service = apiServiceWith(database);
  let taskReads = 0;
  service.getTask = async () => {
    taskReads += 1;
    return { task_id: UUID_A, status: "running", phase: "uploading" } as never;
  };
  const result = await service.completeUpload(UUID_A);
  assert.equal(taskReads, 1);
  assert.equal(transactionCalls, 0);
  assert.equal(result.status, "running");
});

test("重复publish已入库素材生成终态幂等任务且不再投递job", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const publishedAsset = {
    id: UUID_A, userId: null, status: "done", phase: "published",
    mediaObjectId: UUID_B, fileName: "image.jpg", mediaType: "image", sizeBytes: 10,
  };
  const database = {
    db: {
      query: {
        assets: { findFirst: async () => publishedAsset },
        videoSources: { findFirst: async () => undefined },
        taskFiles: { findFirst: async () => undefined },
      },
      transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
        insert: () => ({ values: async (value: Record<string, unknown>) => { inserted.push(value); } }),
      }),
    },
  };
  const service = apiServiceWith(database);
  service.getTask = async () => ({ task_id: UUID_A, status: "done", phase: "published" }) as never;
  const result = await service.queueMutation("publish", { file_id: UUID_A });
  assert.equal(result.status, "done");
  assert.equal(inserted.length, 2, "只应写task和task_file，不应再写job");
  assert.deepEqual(inserted.map((row) => [row.status, row.phase]), [
    ["done", "published"], ["done", "published"],
  ]);
});

test("publish必须与待入库素材的用户范围一致", async () => {
  const pendingAsset = {
    id: UUID_A, userId: "owner-1", status: "pending_review", phase: "pending_review",
    mediaObjectId: UUID_B, fileName: "slice.mp4", mediaType: "video", sizeBytes: 10,
  };
  const database = {
    db: {
      query: {
        assets: { findFirst: async () => pendingAsset },
        videoSources: { findFirst: async () => undefined },
        taskFiles: { findFirst: async () => undefined },
      },
    },
  };
  const service = apiServiceWith(database);
  await assert.rejects(
    service.queueMutation("publish", { file_id: UUID_A, user_id: "attacker" }),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test("publish同步拒绝非待入库状态", async () => {
  const processingAsset = {
    id: UUID_A, userId: "owner-1", status: "running", phase: "processing",
    mediaObjectId: UUID_B, fileName: "slice.mp4", mediaType: "video", sizeBytes: 10,
  };
  const database = {
    db: {
      query: {
        assets: { findFirst: async () => processingAsset },
        videoSources: { findFirst: async () => undefined },
        taskFiles: { findFirst: async () => undefined },
      },
    },
  };
  const service = apiServiceWith(database);
  await assert.rejects(
    service.queueMutation("publish", { file_id: UUID_A, user_id: "owner-1" }),
    (error: unknown) => error instanceof ConflictException,
  );
});

test("retry必须与失败处理链的用户范围一致", async () => {
  const failedSource = {
    id: UUID_A, userId: "owner-1", status: "failed", phase: "processing",
    sourceObjectId: UUID_B, fileName: "failed.mp4", sizeBytes: 10,
  };
  const originalTaskFile = {
    id: UUID_C, taskId: UUID_D, videoSourceId: UUID_A, uploadObjectId: UUID_B,
    fileName: "failed.mp4", mediaType: "video", status: "failed", phase: "processing", sizeBytes: 10,
  };
  const database = {
    db: {
      query: {
        assets: { findFirst: async () => undefined },
        videoSources: { findFirst: async () => failedSource },
        taskFiles: { findFirst: async () => originalTaskFile },
        tasks: { findFirst: async () => ({ id: UUID_D, userId: "owner-1" }) },
      },
    },
  };
  const service = apiServiceWith(database);
  await assert.rejects(
    service.queueMutation("retry", { video_source_id: UUID_A, user_id: "attacker" }),
    (error: unknown) => error instanceof ForbiddenException,
  );
});
