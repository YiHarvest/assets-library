import { describe, expect, it } from "vitest";
import {
  canClaimAnalyzeTask,
  DEFAULT_ANALYZE_TASK_SOFT_LIMIT,
} from "@/server/jobs/scheduling";

describe("analysis job scheduling", () => {
  it("多个任务竞争时把单任务分析并发限制为 2", () => {
    expect(DEFAULT_ANALYZE_TASK_SOFT_LIMIT).toBe(2);
    expect(canClaimAnalyzeTask(0, true)).toBe(true);
    expect(canClaimAnalyzeTask(1, true)).toBe(true);
    expect(canClaimAnalyzeTask(2, true)).toBe(false);
    expect(canClaimAnalyzeTask(3, true)).toBe(false);
  });

  it("只有一个任务等待时允许突破软上限", () => {
    expect(canClaimAnalyzeTask(2, false)).toBe(true);
    expect(canClaimAnalyzeTask(3, false)).toBe(true);
  });

  it("支持显式软上限", () => {
    expect(canClaimAnalyzeTask(2, true, 3)).toBe(true);
    expect(canClaimAnalyzeTask(3, true, 3)).toBe(false);
  });
});
