import assert from "node:assert/strict";
import test from "node:test";
import { deleteAssetSchema } from "../src/contracts/schemas";
import { assets, jobs, mediaObjects, taskFiles, tasks, videoSources } from "../src/database/schema";
import { deletionScopeMatches, isFailedProcessingTarget, requestedDeletionUserId, uniqueObjectIds } from "../src/worker/delete-policy";
import { MutationService } from "../src/worker/mutation.service";

test("删除请求支持file_id或video_source_id严格二选一", () => {
  const fileId = "11111111-1111-4111-8111-111111111111";
  const sourceId = "22222222-2222-4222-8222-222222222222";
  assert.equal(deleteAssetSchema.safeParse({ file_id: fileId, user_id: null }).success, true);
  assert.equal(deleteAssetSchema.safeParse({ video_source_id: sourceId, user_id: "user-1" }).success, true);
  assert.equal(deleteAssetSchema.safeParse({ user_id: null }).success, false);
  assert.equal(deleteAssetSchema.safeParse({ file_id: fileId, video_source_id: sourceId }).success, false);
});

test("失败上传删除仅允许failed+processing且user/public范围必须精确相同", () => {
  assert.equal(isFailedProcessingTarget({ status: "failed", phase: "processing" }), true);
  assert.equal(isFailedProcessingTarget({ status: "pending_review", phase: "pending_review" }), false);
  assert.equal(requestedDeletionUserId(" user-1 "), "user-1");
  assert.equal(requestedDeletionUserId(""), null);
  assert.equal(deletionScopeMatches("user-1", "user-1"), true);
  assert.equal(deletionScopeMatches("user-1", null), false);
  assert.equal(deletionScopeMatches(null, "user-1"), false);
  assert.deepEqual(uniqueObjectIds(["a", "a", null, "b"]), ["a", "b"]);
});

test("MutationService删除无asset行的失败图片：回收tmp并终结原上传任务", async () => {
  process.env.DATABASE_URL ??= "mysql://user:pass@127.0.0.1:3306/assets";
  process.env.ZOS_API_ENDPOINT ??= "https://zos.example.test";
  process.env.ZOS_BUCKET ??= "bucket";
  process.env.ZOS_ACCESS_KEY_ID ??= "access";
  process.env.ZOS_SECRET_ACCESS_KEY ??= "secret";
  process.env.ZOS_WEB_URL ??= "https://cdn.example.test";
  process.env.TEMP_UPLOAD_AUDIT_SALT ??= "0123456789abcdef0123456789abcdef";

  const fileId = "11111111-1111-4111-8111-111111111111";
  const originalTaskId = "22222222-2222-4222-8222-222222222222";
  const taskFileId = "33333333-3333-4333-8333-333333333333";
  const objectId = "44444444-4444-4444-8444-444444444444";
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const db = {
    query: {
      assets: { findFirst: async () => undefined, findMany: async () => [] },
      taskFiles: {
        findFirst: async () => ({ id: taskFileId, taskId: originalTaskId, fileId, videoSourceId: null, uploadObjectId: objectId, status: "failed", phase: "processing" }),
        findMany: async () => [{ id: taskFileId, taskId: originalTaskId }],
      },
      tasks: { findFirst: async () => ({ id: originalTaskId, userId: "user-1", errorCode: "processing_failed" }) },
      videoSources: { findFirst: async () => undefined },
      mediaObjects: { findMany: async () => [{ id: objectId, objectKey: "tmp/original", storageClass: "temporary" }] },
    },
    transaction: async (operation: (tx: unknown) => Promise<void>) => operation({
      delete(table: unknown) {
        return { where: async () => { deletes.push(table); } };
      },
      update(table: unknown) {
        return { set(values: Record<string, unknown>) { return { where: async () => { updates.push({ table, values }); } }; } };
      },
      select() {
        return {
          from(table: unknown) {
            if (table === taskFiles) return { where: () => ({ groupBy: async () => [{ status: "done", phase: "expired", count: 1 }] }) };
            if (table === assets) return { where: async () => [{ count: 0 }] };
            throw new Error("unexpected select table");
          },
        };
      },
    }),
  };
  const zosDeletes: string[] = [];
  const service = new MutationService(
    { db } as never,
    { delete: async (key: string) => { zosDeletes.push(key); } } as never,
    { chromaClient: { delete: async () => undefined } } as never,
  );

  const result = await service.delete({ file_id: fileId, user_id: "user-1" });
  assert.deepEqual(result, { status: "done", phase: "expired" });
  assert.deepEqual(zosDeletes, ["tmp/original"]);
  assert.ok(deletes.includes(jobs));
  assert.ok(deletes.includes(mediaObjects));
  const originalFileUpdate = updates.find((entry) => entry.table === taskFiles)!;
  assert.equal(originalFileUpdate.values.uploadObjectId, null);
  assert.equal(originalFileUpdate.values.status, "done");
  assert.equal(originalFileUpdate.values.phase, "expired");
  const originalTaskUpdate = updates.find((entry) => entry.table === tasks)!;
  assert.equal(originalTaskUpdate.values.status, "done");
  assert.equal(originalTaskUpdate.values.phase, "expired");
});

test("MutationService按video_source_id原子清理失败父视频、临时切片与封面", async () => {
  process.env.DATABASE_URL ??= "mysql://user:pass@127.0.0.1:3306/assets";
  process.env.ZOS_API_ENDPOINT ??= "https://zos.example.test";
  process.env.ZOS_BUCKET ??= "bucket";
  process.env.ZOS_ACCESS_KEY_ID ??= "access";
  process.env.ZOS_SECRET_ACCESS_KEY ??= "secret";
  process.env.ZOS_WEB_URL ??= "https://cdn.example.test";
  process.env.TEMP_UPLOAD_AUDIT_SALT ??= "0123456789abcdef0123456789abcdef";
  const sourceId = "55555555-5555-4555-8555-555555555555";
  const originalTaskId = "66666666-6666-4666-8666-666666666666";
  const taskFileId = "77777777-7777-4777-8777-777777777777";
  const retryTaskId = "99999999-9999-4999-8999-999999999999";
  const sourceObjectId = "88888888-8888-4888-8888-888888888888";
  const derived = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", videoSourceId: sourceId, mediaObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", coverObjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", phase: "pending_review" },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", videoSourceId: sourceId, mediaObjectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", coverObjectId: "ffffffff-ffff-4fff-8fff-ffffffffffff", phase: "processing" },
  ];
  const objectRows = [sourceObjectId, ...derived.flatMap((row) => [row.mediaObjectId, row.coverObjectId])]
    .map((id, index) => ({ id, objectKey: `tmp/object-${index}`, storageClass: "temporary" }));
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const db = {
    query: {
      assets: { findFirst: async () => undefined, findMany: async () => derived },
      taskFiles: {
        findFirst: async () => ({ id: taskFileId, taskId: originalTaskId, fileId: null, videoSourceId: sourceId, uploadObjectId: sourceObjectId, status: "failed", phase: "processing" }),
        findMany: async () => [
          { id: taskFileId, taskId: originalTaskId },
          { id: "12121212-1212-4212-8212-121212121212", taskId: retryTaskId },
        ],
      },
      tasks: { findFirst: async () => ({ id: originalTaskId, userId: null, errorCode: "processing_failed" }) },
      videoSources: { findFirst: async () => ({ id: sourceId, userId: null, sourceObjectId, status: "failed", phase: "processing" }) },
      mediaObjects: { findMany: async () => objectRows },
    },
    transaction: async (operation: (tx: unknown) => Promise<void>) => operation({
      delete(table: unknown) { return { where: async () => { deletes.push(table); } }; },
      update(table: unknown) { return { set(values: Record<string, unknown>) { return { where: async () => { updates.push({ table, values }); } }; } }; },
      select() {
        return { from(table: unknown) {
          if (table === taskFiles) return { where: () => ({ groupBy: async () => [{ status: "done", phase: "expired", count: 1 }] }) };
          if (table === assets) return { where: async () => [{ count: 0 }] };
          throw new Error("unexpected select table");
        } };
      },
    }),
  };
  const zosDeletes: string[] = [];
  const chromaDeletes: string[] = [];
  const service = new MutationService(
    { db } as never,
    { delete: async (key: string) => { zosDeletes.push(key); } } as never,
    { chromaClient: { delete: async (id: string) => { chromaDeletes.push(id); } } } as never,
  );

  const result = await service.delete({ video_source_id: sourceId, user_id: null });
  assert.deepEqual(result, { status: "done", phase: "expired" });
  assert.equal(zosDeletes.length, 5);
  assert.deepEqual(new Set(chromaDeletes), new Set(derived.map((row) => row.id)));
  assert.ok(deletes.includes(assets));
  assert.ok(deletes.includes(jobs));
  assert.ok(deletes.includes(mediaObjects));
  const sourceUpdate = updates.find((entry) => entry.table === videoSources)!;
  assert.equal(sourceUpdate.values.sourceObjectId, null);
  assert.equal(sourceUpdate.values.status, "done");
  assert.equal(sourceUpdate.values.phase, "expired");
  assert.equal(updates.filter((entry) => entry.table === tasks).length, 2, "原上传和失败retry任务都必须终结");
});
