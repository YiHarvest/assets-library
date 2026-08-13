import { describe, expect, it } from "vitest";
import { uploadItemTerminalState } from "@/server/services/task-lifecycle";

describe("上传 item 终态聚合", () => {
  it("等待仍在分析的兄弟切片", () => {
    expect(
      uploadItemTerminalState([
        { status: "completed", directPublish: true, reviewStatus: "pending_review" },
        { status: "analyzing", directPublish: true, reviewStatus: "pending_review" },
      ]),
    ).toBeNull();
  });

  it("任一切片失败且其余分析结束后立即失败，不再等待发布", () => {
    expect(
      uploadItemTerminalState([
        { status: "failed", directPublish: true, reviewStatus: "pending_review" },
        { status: "completed", directPublish: true, reviewStatus: "pending_review" },
      ]),
    ).toEqual({ failed: true });
  });

  it("自动发布任务在全部切片 published 前继续等待", () => {
    expect(
      uploadItemTerminalState([
        { status: "completed", directPublish: true, reviewStatus: "pending_review" },
      ]),
    ).toBeNull();
    expect(
      uploadItemTerminalState([
        { status: "completed", directPublish: true, reviewStatus: "published" },
      ]),
    ).toEqual({ failed: false });
  });

  it("手动发布任务完成分析后即可结束", () => {
    expect(
      uploadItemTerminalState([
        { status: "completed", directPublish: false, reviewStatus: "pending_review" },
      ]),
    ).toEqual({ failed: false });
  });
});
