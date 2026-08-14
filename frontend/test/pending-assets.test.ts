import assert from "node:assert/strict";
import test from "node:test";
import { pendingFiles } from "../src/lib/pending-assets";
import type { TaskResponse } from "../src/shared/contracts";

function task(taskId: string, files: TaskResponse["files"]): TaskResponse {
  return {
    task_id: taskId,
    task_type: "upload",
    status: "pending_review",
    phase: "pending_review",
    total_files: files.length,
    done_files: files.length,
    failed_files: 0,
    files,
    created_at: "2026-08-14T00:00:00.000Z",
  };
}

test("已入库素材不会继续显示在待入库列表", () => {
  const result = pendingFiles([
    task("task-1", [
      { file_id: "file-1", file_name: "a.jpg", media_type: "image", status: "done", phase: "published" },
      { file_id: "file-2", file_name: "b.jpg", media_type: "image", status: "pending_review", phase: "pending_review", media_url: "https://example.test/b.jpg", cover_url: "https://example.test/b.jpg" },
    ]),
  ], "user-1");
  assert.deepEqual(result.map((item) => item.file_id), ["file-2"]);
});

test("重试和原上传任务引用同一file_id时只保留最新状态", () => {
  const result = pendingFiles([
    task("new-task", [
      { file_id: "same-file", file_name: "a.jpg", media_type: "image", status: "failed", phase: "processing" },
    ]),
    task("old-task", [
      { file_id: "same-file", file_name: "a.jpg", media_type: "image", status: "pending_review", phase: "pending_review", media_url: "https://example.test/a.jpg", cover_url: "https://example.test/a.jpg" },
    ]),
  ], "user-1");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "failed");
});

test("内容相同但file_id不同的两张图片仍分别显示", () => {
  const result = pendingFiles([
    task("task-1", [
      { file_id: "file-a", file_name: "same.jpg", media_type: "image", status: "pending_review", phase: "pending_review", media_url: "https://example.test/a.jpg", cover_url: "https://example.test/a.jpg" },
      { file_id: "file-b", file_name: "same.jpg", media_type: "image", status: "pending_review", phase: "pending_review", media_url: "https://example.test/b.jpg", cover_url: "https://example.test/b.jpg" },
    ]),
  ], "user-1");
  assert.deepEqual(result.map((item) => item.file_id), ["file-a", "file-b"]);
});

test("没有素材记录和预览地址的历史 pending_review 孤儿不会显示", () => {
  const orphanTask = task("orphan-task", [{
      file_id: "orphan-file",
      file_name: "deleted.jpg",
      media_type: "image",
      status: "pending_review",
      phase: "pending_review",
    }]);

  assert.deepEqual(pendingFiles([orphanTask], ""), []);
});
