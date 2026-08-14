import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { AssetsController } from "../src/modules/assets/assets.controller";
import { StorageController } from "../src/modules/storage/storage.controller";
import { TemporaryFilesController } from "../src/modules/temporary-files/temporary-files.controller";
import { eventSchema } from "../src/modules/observability/observability.controller";
import { decodeCursor, encodeCursor } from "../src/services/api.service";

function status(target: object, method: string) {
  return Reflect.getMetadata(HTTP_CODE_METADATA, (target as Record<string, unknown>)[method] as object);
}

test("路由显式返回冻结契约的同步/异步状态码", () => {
  assert.equal(status(TemporaryFilesController.prototype, "upload"), 200);
  assert.equal(status(AssetsController.prototype, "list"), 200);
  assert.equal(status(AssetsController.prototype, "search"), 200);
  assert.equal(status(StorageController.prototype, "usage"), 200);
  for (const action of ["update", "publish", "retry", "delete"]) {
    assert.equal(status(AssetsController.prototype, action), 202);
  }
});

test("复合游标同时保留时间和file_id", () => {
  const cursor = { created_at: "2026-08-14T10:00:00.123Z", file_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test("观测metadata拒绝白名单外字段", () => {
  const base = { operation_id: "op", event: "upload", step: "request", duration_ms: 12, status: "done" as const };
  assert.equal(eventSchema.safeParse({ ...base, metadata: { task_id: "id", file_count: 2 } }).success, true);
  assert.equal(eventSchema.safeParse({ ...base, metadata: { file_name: "secret.jpg" } }).success, false);
  assert.equal(eventSchema.safeParse({ ...base, metadata: { presigned_url: "https://example.test/?secret=x" } }).success, false);
});
