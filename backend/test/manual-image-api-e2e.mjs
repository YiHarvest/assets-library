#!/usr/bin/env node

/**
 * Real image API smoke test. It writes only newly generated objects/assets and
 * removes every published asset through the public delete API before exiting.
 * This is intentionally excluded from the default unit-test command.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const apiBase = process.env.E2E_API_BASE ?? "http://127.0.0.1:23017/api/v1";
const imagePaths = (process.env.E2E_IMAGE_PATHS
  ?? "/home/yqy/下载/素材库/微信图片_20260803185811_75_9.jpg,/home/yqy/下载/素材库/1.png")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const userId = process.env.E2E_USER_ID?.trim() || `codex-e2e-image-${runId}`;
const wrongUserId = `${userId}-other`;
const createdFileIds = [];
const publishedFileIds = new Set();

function record(step, details = {}) {
  process.stdout.write(`${JSON.stringify({ step, ...details })}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}, expected = [200]) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    throw new Error(`${options.method ?? "GET"} ${path} transport failed: ${reason}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path}: expected ${expected.join("/")}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

async function pollTask(taskId, acceptedTerminal = ["done", "failed", "pending_review"], timeoutMs = 360_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await request(`/tasks?task_id=${encodeURIComponent(taskId)}`);
    last = result.body;
    if (acceptedTerminal.includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`task ${taskId} timed out; last=${JSON.stringify(last)}`);
}

async function queueMutation(path, body) {
  const queued = await request(path, { method: path.includes("delete") ? "DELETE" : path.includes("update") ? "PATCH" : "POST", body: JSON.stringify(body) }, [202]);
  assert(queued.body.task_id, `${path} did not return task_id`);
  return pollTask(queued.body.task_id, ["done", "failed"]);
}

async function verifyPreview(url, label) {
  assert(/^https?:\/\//.test(url), `${label} is not an HTTP direct URL`);
  let response = await fetch(url, { method: "HEAD" });
  if (!response.ok || !response.headers.get("content-length")) {
    response = await fetch(url, { headers: { range: "bytes=0-0" } });
  }
  assert(response.ok || response.status === 206, `${label} preview returned ${response.status}`);
  record("preview", { label, status: response.status, content_type: response.headers.get("content-type") });
}

async function publishAndDelete(fileId) {
  if (!publishedFileIds.has(fileId)) {
    const published = await queueMutation("/assets/publish", { file_id: fileId, user_id: userId });
    assert(published.status === "done" && published.phase === "published", `publish cleanup failed for ${fileId}`);
    publishedFileIds.add(fileId);
  }
  const softened = await queueMutation("/assets/delete", { file_id: fileId, user_id: userId });
  assert(softened.status === "done" && softened.phase === "published", `soft delete failed for ${fileId}`);
  const hardened = await queueMutation("/assets/delete", { file_id: fileId });
  assert(hardened.status === "done" && hardened.phase === "expired", `hard delete failed for ${fileId}`);
  publishedFileIds.delete(fileId);
}

async function cleanup() {
  for (const fileId of createdFileIds) {
    try {
      const detail = await request(`/assets/detail?file_id=${encodeURIComponent(fileId)}`, {}, [200, 404]);
      if (detail.status === 200) {
        if (detail.body.user_id === userId) {
          await queueMutation("/assets/delete", { file_id: fileId, user_id: userId });
        } else if (detail.body.user_id !== null) {
          record("cleanup_skipped_owner_mismatch", { file_id: fileId });
          continue;
        }
        await queueMutation("/assets/delete", { file_id: fileId });
      } else if (!publishedFileIds.has(fileId)) {
        // A pending-review image cannot be directly deleted by contract. Publish
        // this run's own asset first, then use the normal two-stage delete path.
        await publishAndDelete(fileId);
      }
    } catch (error) {
      record("cleanup_error", { file_id: fileId, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function testFailedUploadDeletion() {
  const created = await request("/uploads", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      auto_publish: false,
      files: [{ media_type: "image", file_name: `missing-object-${runId}.jpg` }],
    }),
  }, [201]);
  const fileId = created.body.files[0]?.file_id;
  assert(fileId, "failed-upload fixture has no file_id");
  const completed = await request("/uploads/complete", {
    method: "POST",
    body: JSON.stringify({ task_id: created.body.task_id }),
  }, [202]);
  assert(completed.body.status === "failed" && completed.body.files[0]?.status === "failed", "missing ZOS object did not fail validation");

  const wrongScope = await request("/assets/delete", {
    method: "DELETE",
    body: JSON.stringify({ file_id: fileId, user_id: wrongUserId }),
  }, [403]);
  const deleted = await queueMutation("/assets/delete", { file_id: fileId, user_id: userId });
  assert(deleted.status === "done" && deleted.phase === "expired", "failed upload delete did not expire the task file");
  const original = await request(`/tasks?task_id=${encodeURIComponent(created.body.task_id)}`);
  assert(original.body.status === "done" && original.body.phase === "expired", "original failed upload task was not re-aggregated to expired");
  const pending = await request(`/tasks?view=pending&user_id=${encodeURIComponent(userId)}&limit=100`);
  assert(!pending.body.tasks.some((task) => task.task_id === created.body.task_id), "deleted failed upload remains in pending tasks");
  record("failed_upload_deleted", {
    file_id: fileId,
    wrong_scope_status: wrongScope.status,
    delete_task_status: deleted.status,
    original_task_status: original.body.status,
    original_task_phase: original.body.phase,
  });
}

async function main() {
  assert(imagePaths.length >= 2, "provide at least two image paths");
  const sources = await Promise.all(imagePaths.slice(0, 2).map(async (path) => ({
    path,
    file_name: basename(path),
    bytes: await readFile(path),
    content_type: path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  })));
  record("run_started", { user_id: userId, files: sources.map((source) => ({ file_name: source.file_name, size_bytes: source.bytes.byteLength })) });

  const invalidBatch = await request("/uploads", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, files: Array.from({ length: 10 }, (_, index) => ({ media_type: "image", file_name: `${index}.jpg` })) }),
  }, [400]);
  record("invalid_batch_rejected", { status: invalidBatch.status });

  await testFailedUploadDeletion();

  const created = await request("/uploads", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      auto_publish: false,
      files: sources.map((source) => ({ media_type: "image", file_name: source.file_name })),
    }),
  }, [201]);
  assert(created.body.status === "queued" && created.body.phase === "uploading", "unexpected create state");
  assert(created.body.files.length === sources.length, "upload target count mismatch");
  for (const target of created.body.files) {
    assert(target.file_id && target.upload_url, "image target is missing file_id/upload_url");
    createdFileIds.push(target.file_id);
  }
  record("upload_created", { status: created.status, task_id: created.body.task_id, file_ids: createdFileIds });

  for (const [index, target] of created.body.files.entries()) {
    const response = await fetch(target.upload_url, {
      method: "PUT",
      headers: { "content-type": sources[index].content_type },
      body: sources[index].bytes,
    });
    assert(response.ok, `presigned PUT ${index} returned ${response.status}`);
    record("zos_put", { file_id: target.file_id, status: response.status, size_bytes: sources[index].bytes.byteLength });
  }

  const completed = await request("/uploads/complete", {
    method: "POST",
    body: JSON.stringify({ task_id: created.body.task_id }),
  }, [202]);
  record("upload_completed", { status: completed.status, task_status: completed.body.status, phase: completed.body.phase });

  const uploadTask = await pollTask(created.body.task_id, ["pending_review", "failed"], 600_000);
  record("analysis_terminal", { task_id: uploadTask.task_id, status: uploadTask.status, phase: uploadTask.phase, done_files: uploadTask.done_files, failed_files: uploadTask.failed_files });
  assert(uploadTask.status === "pending_review", `analysis failed: ${JSON.stringify(uploadTask.error ?? uploadTask.files)}`);
  assert(uploadTask.files.length === 2 && uploadTask.files.every((file) => file.status === "pending_review"), "not all images reached pending_review");
  for (const file of uploadTask.files) {
    assert(file.media_url && file.cover_url, `pending file ${file.file_id} has no preview URL`);
    assert(file.media_url === file.cover_url, `image ${file.file_id} must use the same media_url and cover_url`);
    await verifyPreview(file.cover_url, `pending:${file.file_id}`);
  }

  const pending = await request(`/tasks?view=pending&user_id=${encodeURIComponent(userId)}&limit=20`);
  const pendingTask = pending.body.tasks.find((task) => task.task_id === created.body.task_id);
  assert(pendingTask, "upload task missing from personal pending list");
  assert(pendingTask.files.length === 2, "pending task lost a file");
  record("pending_list", { status: pending.status, task_found: true, file_count: pendingTask.files.length });

  const firstFileId = createdFileIds[0];
  const publishTask = await queueMutation("/assets/publish", { file_id: firstFileId, user_id: userId });
  assert(publishTask.status === "done" && publishTask.phase === "published", `manual publish failed: ${JSON.stringify(publishTask)}`);
  publishedFileIds.add(firstFileId);
  record("published", { file_id: firstFileId, task_id: publishTask.task_id, status: publishTask.status, phase: publishTask.phase });

  const idempotent = await request("/assets/publish", { method: "POST", body: JSON.stringify({ file_id: firstFileId, user_id: userId }) }, [202]);
  assert(idempotent.body.status === "done" && idempotent.body.phase === "published", "published retry is not idempotent");
  record("publish_idempotent", { status: idempotent.status, task_status: idempotent.body.status });

  const detail = await request(`/assets/detail?file_id=${encodeURIComponent(firstFileId)}`);
  assert(detail.body.user_id === userId && detail.body.media_type === "image", "detail ownership/media_type mismatch");
  assert(detail.body.analysis?.ocr && Object.hasOwn(detail.body.analysis.ocr, "text"), "image OCR shape is missing");
  await verifyPreview(detail.body.cover_url, `published:${firstFileId}`);
  record("detail", { status: detail.status, file_id: detail.body.file_id, has_description: Boolean(detail.body.description), tag_count: detail.body.tags.length, has_ocr_shape: true });

  const listed = await request("/assets/list", { method: "POST", body: JSON.stringify({ user_id: userId, media_type: "image", limit: 20 }) });
  assert(listed.body.files.some((file) => file.file_id === firstFileId), "published image missing from personal list");
  assert(!listed.body.files.some((file) => file.file_id === createdFileIds[1]), "unpublished image leaked into published list");
  record("list", { status: listed.status, total_files: listed.body.total_files, image_files: listed.body.image_files, returned: listed.body.files.length });

  const pendingAfterPublish = await request(`/tasks?view=pending&user_id=${encodeURIComponent(userId)}&limit=20`);
  const currentPending = pendingAfterPublish.body.tasks.flatMap((task) => task.files).filter((file) => file.phase === "pending_review");
  assert(!currentPending.some((file) => file.file_id === firstFileId), "published image still appears as pending_review");
  assert(currentPending.some((file) => file.file_id === createdFileIds[1]), "remaining pending image disappeared");
  record("pending_after_single_publish", { remaining_file_ids: currentPending.filter((file) => createdFileIds.includes(file.file_id)).map((file) => file.file_id) });

  const wrongOwner = await request("/assets/update", {
    method: "PATCH",
    body: JSON.stringify({ file_id: firstFileId, user_id: wrongUserId, description: "must not write" }),
  }, [403]);
  record("update_wrong_owner_rejected", { status: wrongOwner.status });

  const uniqueTag = `codex-e2e-${runId}`;
  const updated = await queueMutation("/assets/update", {
    file_id: firstFileId,
    user_id: userId,
    file_name: `e2e-${runId}.jpg`,
    description: `real image e2e ${runId}`,
    tags: [uniqueTag, "真实链路"],
  });
  assert(updated.status === "done" && updated.phase === "published", "update task failed");
  const updatedDetail = await request(`/assets/detail?file_id=${encodeURIComponent(firstFileId)}`);
  assert(updatedDetail.body.file_name === `e2e-${runId}.jpg`, "file_name update missing");
  assert(updatedDetail.body.description === `real image e2e ${runId}`, "description update missing");
  assert(updatedDetail.body.tags.includes(uniqueTag), "tag update missing");
  record("updated", { status: updated.status, tag_count: updatedDetail.body.tags.length });

  const searched = await request("/assets/search", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, media_type: "image", tags: { all: [uniqueTag] }, limit: 20 }),
  });
  assert(searched.body.files.some((file) => file.file_id === firstFileId), "tag search did not return updated image");
  record("search", { status: searched.status, total_files: searched.body.total_files, matched: searched.body.files.length });

  const usage = await request("/storage/usage", { method: "POST", body: JSON.stringify({ user_id: userId }) });
  assert(usage.body.total_files >= 1 && usage.body.image_files >= 1 && usage.body.total_bytes >= detail.body.size_bytes, "storage usage does not include published image");
  record("storage_usage", { status: usage.status, total_files: usage.body.total_files, image_files: usage.body.image_files, total_bytes: usage.body.total_bytes });

  const mediaUrlBeforeDelete = updatedDetail.body.media_url;
  const softDelete = await queueMutation("/assets/delete", { file_id: firstFileId, user_id: userId });
  assert(softDelete.status === "done" && softDelete.phase === "published", "soft delete task failed");
  publishedFileIds.delete(firstFileId);
  const publicDetail = await request(`/assets/detail?file_id=${encodeURIComponent(firstFileId)}`);
  assert(publicDetail.body.user_id === null, "soft delete did not convert personal asset to public");
  const personalAfterSoftDelete = await request("/assets/list", { method: "POST", body: JSON.stringify({ user_id: userId, limit: 20 }) });
  assert(!personalAfterSoftDelete.body.files.some((file) => file.file_id === firstFileId), "soft-deleted image remains personal");
  const publicAfterSoftDelete = await request("/assets/list", { method: "POST", body: JSON.stringify({ limit: 100 }) });
  assert(publicAfterSoftDelete.body.files.some((file) => file.file_id === firstFileId), "soft-deleted image not visible as public");
  record("soft_deleted", { task_id: softDelete.task_id, detail_user_id: publicDetail.body.user_id });

  const hardDelete = await queueMutation("/assets/delete", { file_id: firstFileId });
  assert(hardDelete.status === "done" && hardDelete.phase === "expired", "hard delete task failed");
  const missingDetail = await request(`/assets/detail?file_id=${encodeURIComponent(firstFileId)}`, {}, [404]);
  assert(missingDetail.status === 404, "hard-deleted detail still exists");
  const deletedPreview = await fetch(mediaUrlBeforeDelete, { method: "HEAD" });
  assert(deletedPreview.status === 404 || deletedPreview.status === 403, `hard-deleted object still returns ${deletedPreview.status}`);
  record("hard_deleted", { task_id: hardDelete.task_id, detail_status: missingDetail.status, object_status: deletedPreview.status });

  await publishAndDelete(createdFileIds[1]);
  record("cleanup_second_image", { file_id: createdFileIds[1], status: "deleted" });
  record("run_completed", { user_id: userId, created_files: createdFileIds.length, remaining_assets: 0 });
}

try {
  if (process.argv.includes("--failed-delete-only")) {
    record("run_started", { user_id: userId, mode: "failed-delete-only" });
    await testFailedUploadDeletion();
  }
  else await main();
} catch (error) {
  record("run_failed", { message: error instanceof Error ? error.message : String(error) });
  await cleanup();
  process.exitCode = 1;
}
