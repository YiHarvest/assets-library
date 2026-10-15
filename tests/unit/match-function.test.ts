import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiV1AssetSummary } from "@/shared/contracts";
import { matchRequestSchema } from "@/shared/monitor-contracts";

const mocks = vi.hoisted(() => ({ query: vi.fn(), enabled: vi.fn(() => true), transaction: vi.fn() }));
vi.mock("@/server/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/server/api/v1/service", () => ({ getApiV1Service: () => ({ queryAssets: mocks.query }) }));
vi.mock("@/server/config", () => ({ loadConfig: () => ({ embeddingConfigured: mocks.enabled() }) }));
import { match, processMatchJob } from "@/server/services/match";

beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); });

describe("素材匹配函数", () => {
  it("保留用户和精确标签过滤，默认只匹配处理完成的素材，并按真实分数排序", async () => {
    const low = { asset_id: "low", semantic_score: 0.4 } as ApiV1AssetSummary;
    const high = { asset_id: "high", semantic_score: 0.9 } as ApiV1AssetSummary;
    const mid = { asset_id: "mid", semantic_score: 0.7 } as ApiV1AssetSummary;
    mocks.query.mockResolvedValue({ items: [low, mid, high, { asset_id: "no-score" }] });
    const input = matchRequestSchema.parse({ query: " 海边汽车 ", filter: { user_scope: { mode: "user", user_id: "user-7" }, media_types: ["video"], tags: [{ category: "scene", value: "海边" }] }, limit: 2, min_score: 0.6 });
    const result = await match(input);
    expect(mocks.query).toHaveBeenCalledWith({ query: "海边汽车", keywords: undefined, filter: { ...input.filter, statuses: ["done"] }, cursor: null, limit: 2, include_tag_statistics: false });
    expect(result).toEqual({ query: "海边汽车", items: [high, mid], matched_count: 2, min_score: 0.6 });
  });
  it("未配置 embedding 时明确失败，不能伪装成无匹配结果", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(match(matchRequestSchema.parse({ query: "海边" }))).rejects.toMatchObject({ code: "model_not_configured" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("空结果有效，上游异常不能吞掉", async () => {
    mocks.query.mockResolvedValue({ items: [] });
    await expect(match(matchRequestSchema.parse({ query: "海边" }))).resolves.toMatchObject({ items: [], matched_count: 0 });
    mocks.query.mockRejectedValue(new Error("Elasticsearch unavailable"));
    await expect(match(matchRequestSchema.parse({ query: "海边" }))).rejects.toThrow("Elasticsearch unavailable");
  });
  it("失去租约的 worker 不执行匹配，也不覆盖任务结果", async () => {
    const update = vi.fn();
    const chain = { from: vi.fn(), where: vi.fn(), for: vi.fn().mockResolvedValue([]) };
    chain.from.mockReturnValue(chain); chain.where.mockReturnValue(chain);
    mocks.transaction.mockImplementation((fn) => fn({ select: () => chain, update }));
    await processMatchJob({ id: "job", taskId: "task", assetId: null, type: "match", attempt: 1, payload: { query: "海边" } });
    expect(update).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
});
