import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = () => Promise.resolve([{ id: "asset", type: "upload" }]);
  const select = () => ({ from: () => ({ where: () => ({
    for: () => ({ limit: rows }), limit: rows,
  }) }) });
  const set = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
  const tx = { select, update: () => ({ set }), insert: vi.fn() };
  return {
    set, tx, asset: vi.fn(), refresh: vi.fn(),
    db: { select, transaction: async (run: (value: typeof tx) => unknown) => run(tx) },
  };
});

vi.mock("@/server/db", () => ({ db: mocks.db }));
vi.mock("@/server/repositories/assets", () => ({
  getAssetRecord: mocks.asset, heartbeatJob: vi.fn(), failJob: vi.fn(),
  searchAssetsByDescriptionDetailed: vi.fn(),
}));
vi.mock("@/server/services/task-lifecycle", () => ({ refreshTaskForAsset: mocks.refresh }));
vi.mock("@/server/media/storage", async (original) => {
  const { AppError } = await import("@/server/errors");
  return { ...await original<typeof import("@/server/media/storage")>(),
    readVideoFrames: () => { throw new AppError("video_frames_missing"); },
  };
});

import { processJob } from "@/server/services/processing";
import type { ClaimedJob } from "@/server/repositories/assets";
import type { MultimodalAnalyzer } from "@/server/model/analyzer";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(["prepare_frames", "analyze", "persist_analysis"])(
  "traces original errors at %s before persisting the generic public failure",
  async (stage) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const job: ClaimedJob = {
      id: "job", taskId: "task", assetId: "asset", type: "analyze", attempt: 1, payload: null,
    };
    mocks.asset.mockResolvedValue({
      id: "asset", kind: "public", taskItemId: "item", mediaType: "video", deletedAt: null,
      reviewStatus: "pending_review", mediaObjectId: null, originalFilename: "short.mp4",
      segmentStartMs: 1267, segmentEndMs: 2000,
    });
    const cause = Object.assign(new Error("driver failure"), { code: "DRIVER_ERROR" });
    const original = new Error("original processing error", { cause });
    const analyze = vi.fn<MultimodalAnalyzer["analyze"]>().mockResolvedValue({
      result: { kind: "video", description: "鸡群在地面啄食谷物", topics: [],
        tags: { scene: [], person: [], form: [] }, timeline: [], visualSegments: [], keyMoments: [] },
      model: { protocol: "openai_chat_completions", name: "test-model" },
    });
    const frames = vi.fn().mockResolvedValue(undefined);
    if (stage === "prepare_frames") frames.mockRejectedValue(original);
    if (stage === "analyze") analyze.mockRejectedValue(original);
    mocks.tx.insert.mockImplementation(() => { throw original; });
    await processJob(job, { analyze }, async () => ({ mimeType: "video/mp4", sizeBytes: 100 }), frames);
    const trace = log.mock.calls.map(([line]) => JSON.parse(String(line)))
      .find(entry => entry.event === "worker_analysis_failed");
    expect(trace).toMatchObject({
      task_id: "task", job_id: "job", asset_id: "asset", item_id: "item", attempt: 1,
      stage, filename: "short.mp4", segment_duration_ms: 733,
      error_message: original.message, error_code: "DRIVER_ERROR", error_cause: cause.message,
      error_stack: expect.any(Array), duration_ms: expect.any(Number),
    });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorCode: "internal_error", errorMessage: "系统处理失败，请稍后重试。",
    }));
    expect(mocks.refresh).toHaveBeenCalledWith("asset");
  },
);
