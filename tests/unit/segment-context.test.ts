import { describe, expect, it } from "vitest";
import { segmentRecallContexts } from "@/server/search/segment-context";

describe("business segment recall context", () => {
  it("completes a sentence and retains its preceding antecedent without merging repeated group tuples", () => {
    const segments = [
      { text: "目前只有安卓手机", group_id: [1, 2] }, { text: "可以跑这种模式", group_id: [2, 2] },
      { text: "店关着门", group_id: [1, 2] }, { text: "它也在干活", group_id: [2, 2] },
      { text: "评论区见", group_id: [1, 1] },
    ];
    const original = structuredClone(segments);
    const contexts = segmentRecallContexts(segments);
    expect(contexts[3]).toBe("目前只有安卓手机，可以跑这种模式，店关着门，它也在干活");
    expect(contexts[0]).toBe("目前只有安卓手机，可以跑这种模式");
    expect(contexts[4]).toBe("店关着门，它也在干活，评论区见");
    expect(segments).toEqual(original);
  });

  it("keeps malformed or incomplete groups local instead of swallowing later segments", () => {
    expect(segmentRecallContexts([
      { text: "甲", group_id: [1, 99] }, { text: "乙", group_id: [2, 3] }, { text: "丙", group_id: [] },
    ])).toEqual(["甲", "甲，乙", "乙，丙"]);
  });
});
