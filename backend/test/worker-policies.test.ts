import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCallbackTaskDto,
  callbackRequestHeaders,
  callbackRetryDelayMs,
  isPrivateCallbackAddress,
  isRetryableCallbackStatus,
} from "../src/callbacks/callback.service";
import { canAcquirePublicationLease, publicationLeaseDisposition, shouldDeleteCompensatingObject } from "../src/worker/publication-policy";
import { aggregateUploadTask, purgeAtForState, shouldReconcileUploadTask, videoSourceState } from "../src/worker/task-state";
import { displayDimensions } from "../src/analysis/image-dimensions";
import { canDeleteOrphanVideoSource, canEditPersonalAsset, deleteDerivedIndexBestEffort } from "../src/worker/mutation-policy";
import { isBrowserCompatibleMp4 } from "../src/analysis/media-tools";
import { isMaintenanceWorker } from "../src/worker/worker-role";
import { workerHeartbeatPaths } from "../src/worker-heartbeat";
import { segmentJobsReadyForFinalize, shouldScheduleVideoFinalize } from "../src/worker/video-job-policy";

test("多worker只有1号执行维护且每个实例使用独立心跳", () => {
  assert.equal(isMaintenanceWorker(1), true);
  assert.equal(isMaintenanceWorker(2), false);
  assert.equal(isMaintenanceWorker(3), false);
  const previousRuntimeDir = process.env.RUNTIME_DIR;
  process.env.RUNTIME_DIR = "/tmp/assets-library-worker-test";
  try {
    assert.deepEqual(workerHeartbeatPaths(3), [
      "/tmp/assets-library-worker-test/worker-1.heartbeat.json",
      "/tmp/assets-library-worker-test/worker-2.heartbeat.json",
      "/tmp/assets-library-worker-test/worker-3.heartbeat.json",
    ]);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.RUNTIME_DIR;
    else process.env.RUNTIME_DIR = previousRuntimeDir;
  }
});

test("视频仅在全部切片终态后汇总，切片重试后可重新汇总", () => {
  const first = new Date("2026-08-14T00:00:00Z");
  const retried = new Date("2026-08-14T00:01:00Z");
  const running = [{ status: "done" as const, updatedAt: first }, { status: "running" as const, updatedAt: first }];
  const terminal = [{ status: "done" as const, updatedAt: retried }, { status: "failed" as const, updatedAt: retried }];
  assert.equal(segmentJobsReadyForFinalize(running), false);
  assert.equal(segmentJobsReadyForFinalize(terminal), true);
  assert.equal(shouldScheduleVideoFinalize(terminal, undefined), true);
  assert.equal(shouldScheduleVideoFinalize(terminal, { status: "running", updatedAt: first }), false);
  assert.equal(shouldScheduleVideoFinalize(terminal, { status: "done", updatedAt: first }), true);
  assert.equal(shouldScheduleVideoFinalize(terminal, { status: "done", updatedAt: retried }), false);
});

test("维护对账不推进 queued/running + uploading，complete 仍可认领", () => {
  assert.equal(shouldReconcileUploadTask("queued", "uploading"), false);
  assert.equal(shouldReconcileUploadTask("running", "uploading"), false);
  assert.equal(shouldReconcileUploadTask("queued", "processing"), true);
  assert.equal(shouldReconcileUploadTask("running", "processing"), true);
  assert.equal(shouldReconcileUploadTask("failed", "processing"), true);
  assert.equal(shouldReconcileUploadTask("pending_review", "pending_review"), true);
});

test("H.264 非 yuv420p 或非 AAC 音轨必须转码", () => {
  assert.equal(isBrowserCompatibleMp4({ codecName: "h264", pixelFormat: "yuv420p", audioCodecName: null }), true);
  assert.equal(isBrowserCompatibleMp4({ codecName: "h264", pixelFormat: "yuv420p", audioCodecName: "aac" }), true);
  assert.equal(isBrowserCompatibleMp4({ codecName: "h264", pixelFormat: "yuv444p", audioCodecName: "aac" }), false);
  assert.equal(isBrowserCompatibleMp4({ codecName: "h264", pixelFormat: "yuv420p10le", audioCodecName: "aac" }), false);
  assert.equal(isBrowserCompatibleMp4({ codecName: "h264", pixelFormat: "yuv420p", audioCodecName: "opus" }), false);
  assert.equal(isBrowserCompatibleMp4({ codecName: "hevc", pixelFormat: "yuv420p", audioCodecName: "aac" }), false);
});

test("图片批次部分成功时保留失败计数但不进入 failed", () => {
  const pending = aggregateUploadTask([
    { status: "pending_review", phase: "pending_review", count: 2 },
    { status: "failed", phase: "processing", count: 1 },
  ]);
  assert.deepEqual(pending, { status: "pending_review", phase: "pending_review", totalFiles: 3, doneFiles: 2, failedFiles: 1 });
  const published = aggregateUploadTask([
    { status: "done", phase: "published", count: 2 },
    { status: "failed", phase: "processing", count: 1 },
  ]);
  assert.equal(published.status, "done");
  assert.equal(published.phase, "published");
  assert.equal(published.failedFiles, 1);
});

test("图片尺寸仅按EXIF展示方向记录，不限制像素", () => {
  assert.deepEqual(displayDimensions(1080, 1920, 6), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions(1920, 1080, 1), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions(8000, 6000, 1), { width: 8000, height: 6000 });
});

test("仅最后切片且父源临时对象已释放时删除video_source", () => {
  assert.equal(canDeleteOrphanVideoSource({ sourceObjectId: "tmp-object", status: "done", phase: "published" }, 0), false);
  assert.equal(canDeleteOrphanVideoSource({ sourceObjectId: null, status: "running", phase: "processing" }, 0), false);
  assert.equal(canDeleteOrphanVideoSource({ sourceObjectId: null, status: "done", phase: "published" }, 1), false);
  assert.equal(canDeleteOrphanVideoSource({ sourceObjectId: null, status: "done", phase: "published" }, 0), true);
});

test("本人素材在待入库和已入库阶段都可以编辑", () => {
  assert.equal(canEditPersonalAsset({ userId: "user-1", phase: "pending_review" }, "user-1"), true);
  assert.equal(canEditPersonalAsset({ userId: "user-1", phase: "published" }, "user-1"), true);
  assert.equal(canEditPersonalAsset({ userId: "user-2", phase: "published" }, "user-1"), false);
  assert.equal(canEditPersonalAsset({ userId: "user-1", phase: "processing" }, "user-1"), false);
});

test("Chroma 派生索引失败不阻断规范数据删除", async () => {
  assert.equal(await deleteDerivedIndexBestEffort(async () => undefined), true);
  assert.equal(await deleteDerivedIndexBestEffort(async () => { throw new Error("chroma unavailable"); }), false);
});

test("pending_review 不清理，expired 终态从当前时间保留24小时", () => {
  const now = new Date("2026-08-14T00:00:00.000Z");
  assert.equal(purgeAtForState("pending_review", "pending_review", now, 24), null);
  assert.equal(purgeAtForState("done", "expired", now, 24)?.toISOString(), "2026-08-15T00:00:00.000Z");
  assert.deepEqual(videoSourceState(["published", "expired"]), { status: "done", phase: "published" });
  assert.deepEqual(videoSourceState(["published", "pending_review"]), { status: "pending_review", phase: "pending_review" });
  assert.deepEqual(
    aggregateUploadTask([
      { status: "done", phase: "published", count: 1 },
      { status: "done", phase: "expired", count: 2 },
    ]),
    { status: "done", phase: "published", totalFiles: 3, doneFiles: 3, failedFiles: 0 },
  );
});

test("发布租约互斥、陈旧租约可恢复、补偿不删除已引用永久对象", () => {
  const staleBefore = new Date("2026-08-14T00:00:00.000Z");
  assert.equal(canAcquirePublicationLease({ status: "pending_review", phase: "pending_review", updatedAt: staleBefore }, staleBefore), true);
  assert.equal(canAcquirePublicationLease({ status: "running", phase: "processing", updatedAt: new Date("2026-08-14T00:01:00.000Z") }, staleBefore), false);
  assert.equal(canAcquirePublicationLease({ status: "running", phase: "processing", updatedAt: new Date("2026-08-13T23:59:00.000Z") }, staleBefore), true);
  assert.equal(shouldDeleteCompensatingObject(true), false);
  assert.equal(shouldDeleteCompensatingObject(false), true);
  const state = { status: "pending_review", phase: "pending_review", updatedAt: staleBefore };
  let copies = 0;
  const attempt = () => {
    const disposition = publicationLeaseDisposition(state, staleBefore);
    if (disposition !== "acquire") return disposition;
    state.status = "running"; state.phase = "processing"; state.updatedAt = new Date("2026-08-14T00:01:00.000Z"); copies += 1;
    return disposition;
  };
  assert.equal(attempt(), "acquire");
  assert.equal(attempt(), "busy");
  assert.equal(copies, 1);
  state.status = "done"; state.phase = "published";
  assert.equal(attempt(), "already_published");
});

test("callback DTO/Header/重试分类与退避严格符合契约", () => {
  const dto = buildCallbackTaskDto({ id: "task-1", type: "upload", status: "done", phase: "published", totalFiles: 1, doneFiles: 1, failedFiles: 0, errorCode: null, errorMessage: null, errorDetails: null, createdAt: new Date("2026-08-14T00:00:00Z"), finishedAt: null }, []);
  assert.equal(dto.task_type, "upload");
  assert.equal("error" in dto, false);
  assert.equal("finished_at" in dto, false);
  assert.deepEqual(callbackRequestHeaders("{}", "task-1"), { "content-type": "application/json", "content-length": 2, "X-Task-ID": "task-1" });
  assert.deepEqual([1, 2, 3, 4].map(callbackRetryDelayMs), [60_000, 300_000, 900_000, 3_600_000]);
  assert.equal(callbackRetryDelayMs(5), undefined);
  for (const status of [408, 429, 500, 503]) assert.equal(isRetryableCallbackStatus(status), true);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryableCallbackStatus(status), false);
});

test("callback SSRF 拒绝常见内网、CGNAT、IPv6本地地址", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "100.64.1.2", "169.254.1.2", "172.16.1.2", "192.168.1.2", "198.18.0.1", "203.0.113.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) {
    assert.equal(isPrivateCallbackAddress(address), true, address);
  }
  assert.equal(isPrivateCallbackAddress("8.8.8.8"), false);
});
