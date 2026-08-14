import assert from "node:assert/strict";
import test from "node:test";
import { ZosService } from "../src/storage/zos.service";

test("ZOS copy将AbortSignal传给SDK发送调用", async () => {
  const calls: unknown[] = [];
  const service = Object.create(ZosService.prototype) as ZosService;
  Object.defineProperty(service, "config", { value: { ZOS_BUCKET: "bucket" } });
  Object.defineProperty(service, "client", { value: { send: async (_command: unknown, options: unknown) => { calls.push(options); } } });
  Object.defineProperty(service, "head", { value: async () => ({ sizeBytes: 1 }) });
  const controller = new AbortController();
  controller.abort();
  await service.copy("tmp/source", "assets/destination", controller.signal);
  assert.equal((calls[0] as { abortSignal?: AbortSignal }).abortSignal, controller.signal);
});

test("临时上传直接写入tmp并返回24小时结果", async () => {
  const uploadedAt = new Date("2026-08-14T04:00:00.000Z");
  const service = Object.create(ZosService.prototype) as ZosService;
  Object.defineProperty(service, "config", {
    value: { ZOS_TMP_PREFIX: "tmp/test_assets", TEMP_FILE_TTL_HOURS: 24 },
  });
  Object.defineProperty(service, "put", {
    value: async (key: string) => ({
      key,
      url: `https://oss.example/${key}`,
      sizeBytes: 3,
      contentType: "image/jpeg",
      lastModified: uploadedAt,
    }),
  });

  const result = await service.putTemporary(
    "00000000-0000-4000-8000-000000000001",
    "jpg",
    Buffer.from([1, 2, 3]),
    "image/jpeg",
  );

  assert.deepEqual(result, {
    url: "https://oss.example/tmp/test_assets/00000000-0000-4000-8000-000000000001.jpg",
    key: "tmp/test_assets/00000000-0000-4000-8000-000000000001.jpg",
    size: 3,
    contentType: "image/jpeg",
    uploadTime: "2026-08-14T04:00:00.000Z",
    expireTime: "2026-08-15T04:00:00.000Z",
    message: "临时文件上传成功，将在24小时后清理",
  });
});

test("临时上传失败时只补偿删除本次生成的key", async () => {
  const deleted: string[] = [];
  const service = Object.create(ZosService.prototype) as ZosService;
  Object.defineProperty(service, "config", {
    value: { ZOS_TMP_PREFIX: "tmp/test_assets", TEMP_FILE_TTL_HOURS: 24 },
  });
  Object.defineProperty(service, "put", {
    value: async () => { throw new Error("head failed"); },
  });
  Object.defineProperty(service, "delete", {
    value: async (key: string) => { deleted.push(key); },
  });

  await assert.rejects(
    service.putTemporary("file-id", "mp4", Buffer.from([1]), "video/mp4"),
    /head failed/,
  );
  assert.deepEqual(deleted, ["tmp/test_assets/file-id.mp4"]);
});
