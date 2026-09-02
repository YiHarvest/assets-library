import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callback: vi.fn(),
  compatibilityMatch: vi.fn(),
  completeJob: vi.fn().mockResolvedValue(1),
  failJob: vi.fn().mockResolvedValue(1),
  heartbeatJob: vi.fn().mockResolvedValue(1),
  mutation: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("@/server/config", () => ({
  loadConfig: () => ({
    SCENE_DETECT_BASE_URL: "https://your.com",
    SCENE_DETECT_TIMEOUT_MS: 1_000,
  }),
}));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/repositories/assets", () => ({
  completeJob: mocks.completeJob,
  failJob: mocks.failJob,
  getAssetRecord: vi.fn(),
  heartbeatJob: mocks.heartbeatJob,
  requeueJob: vi.fn(),
}));
vi.mock("@/server/services/upload-pipeline", () => ({
  processValidateJob: mocks.validate,
}));
vi.mock("@/server/services/mutation-pipeline", () => ({
  processMutationJob: mocks.mutation,
}));
vi.mock("@/server/services/compatibility-match", () => ({
  processCompatibilityMatchJob: mocks.compatibilityMatch,
}));
vi.mock("@/server/services/callbacks", () => ({
  processCallbackJob: mocks.callback,
}));
vi.mock("@/server/services/task-lifecycle", () => ({
  failMutationTask: vi.fn(),
  finishMutationTask: vi.fn(),
  refreshTaskForAsset: vi.fn(),
}));
vi.mock("@/server/storage/zos", () => ({
  createZosObjectStorage: vi.fn(),
}));

import { processJob } from "@/server/services/processing";
import type { ClaimedJob } from "@/server/repositories/assets";
import type { MultimodalAnalyzer } from "@/server/model/analyzer";
import type { ObjectStorage } from "@/server/storage/object-storage";

const analyzer = {} as MultimodalAnalyzer;
const storage = {} as ObjectStorage;

function job(type: ClaimedJob["type"]): ClaimedJob {
  return {
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    assetId:
      type === "validate" || type === "callback" || type === "match"
        ? null
        : crypto.randomUUID(),
    type,
    attempt: 1,
    payload:
      type === "validate" ? { taskItemId: crypto.randomUUID() } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("worker dispatcher", () => {
  it("把 validate 作业交给上传流水线", async () => {
    const claimed = job("validate");
    await processJob(claimed, analyzer, undefined, undefined, storage);
    expect(mocks.validate).toHaveBeenCalledWith(
      claimed,
      expect.objectContaining({ storage }),
    );
  });

  it.each(["update", "publish", "retry", "delete"] as const)(
    "把 %s 作业交给异步变更流水线",
    async (type) => {
      const claimed = job(type);
      await processJob(claimed, analyzer, undefined, undefined, storage);
      expect(mocks.mutation).toHaveBeenCalledWith(claimed, storage);
    },
  );

  it("把 callback 作业交给可靠回调投递器", async () => {
    const claimed = job("callback");
    await processJob(claimed, analyzer, undefined, undefined, storage);
    expect(mocks.callback).toHaveBeenCalledWith(claimed);
  });

  it("把 match 作业交给兼容分段匹配流水线", async () => {
    const claimed = job("match");
    await processJob(claimed, analyzer, undefined, undefined, storage);
    expect(mocks.compatibilityMatch).toHaveBeenCalledWith(claimed);
  });
});
