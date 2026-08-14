import assert from "node:assert/strict";
import test from "node:test";
import { corsAllowlist } from "../src/common/cors-policy";
import { configureHttpServerTimeouts, HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from "../src/common/http-server-policy";
import { DEFAULT_SCENE_HEALTH_TIMEOUT_MS, DEFAULT_SCENE_SEGMENT_MAX_BYTES } from "../src/config";
import { fileExpired, storageUnavailable } from "../src/services/api.service";
import { isRetryableProcessingState } from "../src/services/retry-policy";
import { UploadObjectTooLargeError, assertUploadObjectSize, inspectUploadedObject, isStorageObjectMissingError } from "../src/services/upload-size-policy";

test("HEAD大小策略在读取对象前拒绝超限图片和视频", () => {
  assert.doesNotThrow(() => assertUploadObjectSize("image", 20, 20, 200));
  assert.throws(() => assertUploadObjectSize("image", 21, 20, 200), UploadObjectTooLargeError);
  assert.throws(() => assertUploadObjectSize("video", 201, 20, 200), UploadObjectTooLargeError);
  assert.throws(() => assertUploadObjectSize("video", 0, 20, 200), UploadObjectTooLargeError);
});

test("超限预签名对象在complete阶段立即删除且不进入下载", async () => {
  const calls: string[] = [];
  const storage = {
    async head(key: string) { calls.push(`head:${key}`); return { sizeBytes: 201 }; },
    async delete(key: string) { calls.push(`delete:${key}`); },
  };
  await assert.rejects(
    inspectUploadedObject({ mediaType: "video", objectKey: "tmp/video" }, storage, { imageBytes: 20, videoBytes: 200 }),
    UploadObjectTooLargeError,
  );
  assert.deepEqual(calls, ["head:tmp/video", "delete:tmp/video"]);
});

test("retry严格限制failed+processing，不把pending_review当publish", () => {
  assert.equal(isRetryableProcessingState({ status: "failed", phase: "processing" }), true);
  assert.equal(isRetryableProcessingState({ status: "pending_review", phase: "pending_review" }), false);
  assert.equal(isRetryableProcessingState({ status: "done", phase: "expired" }), false);
});

test("过期冲突返回稳定file_expired结构", () => {
  const response = fileExpired().getResponse();
  assert.deepEqual(response, { error: { code: "file_expired", message: "临时文件已经过期，请重新上传。" } });
});

test("retry只把明确404/NoSuchKey分类为过期，存储故障保持503", () => {
  assert.equal(isStorageObjectMissingError({ name: "NoSuchKey" }), true);
  assert.equal(isStorageObjectMissingError({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isStorageObjectMissingError({ name: "TimeoutError" }), false);
  assert.equal(isStorageObjectMissingError({ $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(isStorageObjectMissingError({ $metadata: { httpStatusCode: 503 } }), false);
  assert.deepEqual(storageUnavailable().getResponse(), {
    error: { code: "storage_unavailable", message: "存储服务暂时不可用，请稍后重试。" },
  });
});

test("未配置CORS时禁用跨域，仅显式逗号allowlist启用", () => {
  assert.equal(corsAllowlist(undefined), false);
  assert.equal(corsAllowlist(" , "), false);
  assert.deepEqual(corsAllowlist("https://a.example, https://b.example,,"), ["https://a.example", "https://b.example"]);
});

test("分镜切片默认上限为10MiB", () => {
  assert.equal(DEFAULT_SCENE_SEGMENT_MAX_BYTES, 10 * 1024 * 1024);
});

test("分镜健康检查默认允许实测约4秒的响应", () => {
  assert.equal(DEFAULT_SCENE_HEALTH_TIMEOUT_MS, 8_000);
});

test("HTTP层将完整请求接收限制为60秒", () => {
  const server = { requestTimeout: 0, headersTimeout: 0 };
  configureHttpServerTimeouts(server);
  assert.equal(server.requestTimeout, 60_000);
  assert.equal(server.requestTimeout, HTTP_REQUEST_TIMEOUT_MS);
  assert.equal(server.headersTimeout, HTTP_HEADERS_TIMEOUT_MS);
  assert.ok(server.headersTimeout < server.requestTimeout);
});
