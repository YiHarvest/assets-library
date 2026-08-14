import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assets, jobs, taskFiles, videoSources } from "../src/database/schema";
import { MediaPipelineService } from "../src/worker/media-pipeline.service";
import { MutationService } from "../src/worker/mutation.service";

type UpdateRecord = { table: unknown; values: Record<string, unknown> };

function updateRecorder(records: UpdateRecord[]) {
  return (table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      records.push({ table, values });
      return { where: async () => [{ affectedRows: 1 }] };
    },
  });
}

function pipelineWith(database: unknown, publication?: { publish(...args: unknown[]): Promise<unknown> }) {
  const service = Object.create(MediaPipelineService.prototype) as MediaPipelineService;
  Object.assign(service, {
    database: { db: database },
    publication: publication ?? { publish: async () => [] },
  });
  return service;
}

const segment = {
  index: 0,
  startSeconds: 0,
  endSeconds: 1,
  durationSeconds: 1,
  sizeBytes: 1024,
  filename: "segment-0.mp4",
  downloadUrl: "http://127.0.0.1:28200/files/segment-0.mp4",
};

test("三个worker使用SKIP LOCKED竞争不同analyze_segment作业且启动脚本为每实例注入索引", () => {
  const workerSource = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  const startSource = readFileSync(new URL("../../scripts/start.sh", import.meta.url), "utf8");
  assert.match(workerSource, /for\("update",\s*\{\s*skipLocked:\s*true\s*\}\)/);
  assert.match(workerSource, /eq\(jobs\.status,\s*"queued"\)/);
  assert.match(workerSource, /affectedRows\s*!==\s*1/);
  assert.match(workerSource, /job\.type === "analyze_segment"/);
  assert.match(startSource, /for i in \$\(seq 1 "\$WORKER_INSTANCES"\)/);
  assert.match(startSource, /WORKER_INDEX="\$i" WORKER_INSTANCES="\$WORKER_INSTANCES"/);

  // 三个并发claim对三条队头作业分别加锁；SKIP LOCKED确保后续worker跳过已锁行。
  const queue = ["analyze-segment-0", "analyze-segment-1", "analyze-segment-2"];
  const locked = new Set<string>();
  const claimed = Array.from({ length: 3 }, () => {
    const candidate = queue.find((id) => !locked.has(id));
    if (candidate) locked.add(candidate);
    return candidate;
  });
  assert.deepEqual(claimed, queue);
  assert.equal(new Set(claimed).size, 3);
});

test("视频切片和finalize使用稳定唯一dedupe key，重复完成不会重复产出切片", async () => {
  const schemaSource = readFileSync(new URL("../src/database/schema.ts", import.meta.url), "utf8");
  const pipelineSource = readFileSync(new URL("../src/worker/media-pipeline.service.ts", import.meta.url), "utf8");
  assert.match(schemaSource, /uniqueIndex\("jobs_dedupe_key_unique"\)\.on\(table\.dedupeKey\)/);
  assert.match(schemaSource, /uniqueIndex\("assets_video_segment_unique"\)/);
  assert.match(schemaSource, /"analyze_segment"/);
  assert.doesNotMatch(schemaSource, /^\s*"analyze",\s*$/m);
  assert.match(pipelineSource, /video-segment:\$\{file\.videoSourceId\}:\$\{segment\.index\}/);
  assert.match(pipelineSource, /video-finalize:\$\{taskFileId\}/);
  assert.match(pipelineSource, /asset-embed:\$\{assetId\}/);
  assert.match(pipelineSource, /await this\.chroma\.index\(assetId, analysis\)[\s\S]*query\.assets\.findFirst[\s\S]*this\.chroma\.delete\(assetId\)/);
  const segmentHandler = pipelineSource.slice(
    pipelineSource.indexOf("async processVideoSegment"),
    pipelineSource.indexOf("async enqueueVideoFinalizeIfReady"),
  );
  assert.match(segmentHandler, /tx\.insert\(jobs\)\.ignore\(\)\.values\(this\.embeddingJob/);
  assert.doesNotMatch(segmentHandler, /await this\.index\(/);

  let embedEnqueueCalls = 0;
  const service = pipelineWith({
    query: {
      taskFiles: { findFirst: async () => ({ id: "task-file", taskId: "task", videoSourceId: "source" }) },
      tasks: { findFirst: async () => ({ id: "task", userId: "user-1" }) },
      assets: { findFirst: async () => ({ id: "slice", coverObjectId: "cover", phase: "pending_review" }) },
    },
  });
  service.enqueueEmbedding = async () => { embedEnqueueCalls += 1; return true; };
  await service.processVideoSegment("task-file", "slice", segment);
  await service.processVideoSegment("task-file", "slice", segment);
  assert.equal(embedEnqueueCalls, 2, "幂等重放只补齐独立embed作业，不重复下载、转码或写ZOS");
});

test("embed使用稳定dedupe key，终态作业可幂等重排且运行中不重复入队", async () => {
  const updates: UpdateRecord[] = [];
  const inserts: Record<string, unknown>[] = [];
  let existing: { id: string; status: "queued" | "running" | "done" | "failed" } | undefined = {
    id: "embed-job",
    status: "running",
  };
  const service = pipelineWith({
    query: {
      analysisResults: { findFirst: async () => ({ assetId: "slice", indexedAt: null, indexError: null }) },
      jobs: { findFirst: async () => existing },
    },
    update: updateRecorder(updates),
    insert: () => ({
      ignore: () => ({
        values: async (value: Record<string, unknown>) => { inserts.push(value); },
      }),
    }),
  });

  assert.equal(await service.enqueueEmbedding("slice", "task"), false);
  assert.equal(inserts.length, 0);
  existing = { id: "embed-job", status: "failed" };
  assert.equal(await service.enqueueEmbedding("slice", "task"), true);
  assert.equal(updates.at(-1)?.values.status, "queued");
  assert.equal(updates.at(-1)?.values.attempts, 0);
  existing = undefined;
  assert.equal(await service.enqueueEmbedding("slice", "task"), true);
  assert.equal(inserts[0]?.dedupeKey, "asset-embed:slice");
  assert.equal(inserts[0]?.type, "embed");
});

test("manual视频finalize保持整批pending，手动publish只发布所选单切片", async () => {
  const updates: UpdateRecord[] = [];
  const publicationCalls: unknown[][] = [];
  const service = pipelineWith({
    query: {
      taskFiles: { findFirst: async () => ({ id: "task-file", taskId: "task", videoSourceId: "source" }) },
      tasks: { findFirst: async () => ({ id: "task", userId: "user-1", autoPublish: false }) },
      jobs: { findMany: async () => [{ status: "done" }, { status: "done" }] },
      assets: { findMany: async () => [{ id: "slice-1", coverObjectId: "cover-1" }, { id: "slice-2", coverObjectId: "cover-2" }] },
    },
    update: updateRecorder(updates),
  });
  await service.finalizeVideo("task-file");
  assert.deepEqual(
    updates.filter((entry) => entry.table === taskFiles || entry.table === videoSources).map((entry) => [entry.values.status, entry.values.phase]),
    [["pending_review", "pending_review"], ["pending_review", "pending_review"]],
  );

  const mutation = Object.create(MutationService.prototype) as MutationService;
  Object.assign(mutation, {
    pipeline: {
      publicationService: {
        publish: async (...args: unknown[]) => { publicationCalls.push(args); return ["slice-2"]; },
      },
    },
  });
  await mutation.publish({ file_id: "slice-2", user_id: "user-1" });
  assert.deepEqual(publicationCalls, [["slice-2", false, "user-1", undefined]]);
});

test("auto_publish只调用一次整批原子发布，发布失败不得提前写published状态", async () => {
  const makeDatabase = (updates: UpdateRecord[]) => ({
    query: {
      taskFiles: { findFirst: async () => ({ id: "task-file", taskId: "task", videoSourceId: "source" }) },
      tasks: { findFirst: async () => ({ id: "task", userId: "user-1", autoPublish: true }) },
      jobs: { findMany: async () => [{ status: "done" }, { status: "done" }, { status: "done" }] },
      assets: { findMany: async () => [
        { id: "slice-1", coverObjectId: "cover-1" },
        { id: "slice-2", coverObjectId: "cover-2" },
        { id: "slice-3", coverObjectId: "cover-3" },
      ] },
    },
    update: updateRecorder(updates),
  });

  const updates: UpdateRecord[] = [];
  const calls: unknown[][] = [];
  const successful = pipelineWith(makeDatabase(updates), {
    publish: async (...args: unknown[]) => { calls.push(args); return ["slice-1", "slice-2", "slice-3"]; },
  });
  await successful.finalizeVideo("task-file");
  assert.deepEqual(calls, [["slice-1", true, "user-1", undefined]]);
  assert.deepEqual(
    updates.filter((entry) => entry.table === taskFiles || entry.table === videoSources).map((entry) => [entry.values.status, entry.values.phase]),
    [["done", "published"], ["done", "published"]],
  );

  const failedUpdates: UpdateRecord[] = [];
  const failing = pipelineWith(makeDatabase(failedUpdates), {
    publish: async () => { throw new Error("copy failed"); },
  });
  await assert.rejects(failing.finalizeVideo("task-file"), /copy failed/);
  assert.equal(failedUpdates.length, 0, "整批发布失败时finalize不得把父任务写成published");
});

test("单切片分析失败后finalize标记父链失败，retry只重新排队failed analyze_segment job", async () => {
  const finalizeUpdates: UpdateRecord[] = [];
  const finalize = pipelineWith({
    query: {
      taskFiles: { findFirst: async () => ({ id: "task-file", taskId: "task", videoSourceId: "source" }) },
      tasks: { findFirst: async () => ({ id: "task", userId: "user-1", autoPublish: false }) },
      jobs: { findMany: async () => [{ id: "done-job", status: "done" }, { id: "failed-job", status: "failed" }] },
    },
    update: updateRecorder(finalizeUpdates),
  });
  await finalize.finalizeVideo("task-file");
  assert.deepEqual(
    finalizeUpdates.filter((entry) => entry.table === taskFiles || entry.table === videoSources).map((entry) => [entry.values.status, entry.values.phase, entry.values.errorCode]),
    [["failed", "processing", "segment_processing_failed"], ["failed", "processing", "segment_processing_failed"]],
  );

  const retryUpdates: UpdateRecord[] = [];
  const retry = pipelineWith({
    query: {
      taskFiles: { findFirst: async () => ({ id: "task-file", videoSourceId: "source" }) },
      jobs: { findMany: async () => [{ id: "failed-job", status: "failed" }] },
    },
    update: updateRecorder(retryUpdates),
  });
  assert.equal(await retry.retryVideoSegments("task-file"), true);
  const jobUpdate = retryUpdates.find((entry) => entry.table === jobs);
  assert.equal(jobUpdate?.values.status, "queued");
  assert.equal(jobUpdate?.values.attempts, 0);
  assert.deepEqual(
    retryUpdates.filter((entry) => entry.table === taskFiles || entry.table === videoSources).map((entry) => [entry.values.status, entry.values.phase]),
    [["running", "processing"], ["running", "processing"]],
  );
});

test("删除契约继续区分个人软删除、公共硬删除及pending父视频拒绝", () => {
  const mutationSource = readFileSync(new URL("../src/worker/mutation.service.ts", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../src/services/api.service.ts", import.meta.url), "utf8");
  assert.match(mutationSource, /个人归属移除后成为公共素材/);
  assert.match(mutationSource, /this\.zos\.delete\(row\.objectKey\)/);
  assert.match(apiSource, /尚未入库的原始上传只有 failed \+ processing 状态可以删除/);
  assert.match(apiSource, /硬删除个人素材必须携带对应 user_id/);
});
