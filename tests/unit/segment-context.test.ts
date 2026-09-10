import { describe, expect, it } from "vitest";
import { requiresRecallContext, segmentRecallContexts } from "@/server/search/segment-context";

describe("business segment recall context", () => {
  it("uses complete groups for grammatical fragments while retaining meaningful short phrases", () => {
    for (const text of ["的姿势", "拿别人已经", "这就是窗口", "而且窗口还在", "那么焦虑了", "你做抖音就不会", "账号不能", "全部也没有", "丝毫全是自己", "是一个样"]) expect(requiresRecallContext(text)).toBe(true);
    for (const text of ["我身边一堆人", "账号还容易出问题", "不会丢失素材", "家和万事兴", "是母亲", "是父亲"]) expect(requiresRecallContext(text)).toBe(false);
  });
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
    expect(contexts[4]).toBe("评论区见");
    expect(segments).toEqual(original);
  });

  it("does not carry an ecommerce paragraph into the next explicit AI topic", () => {
    expect(segmentRecallContexts([
      { text: "抖音和拼多多也是", group_id: [1, 2] }, { text: "现在基本都凉了", group_id: [2, 2] },
      { text: "AI现在", group_id: [1, 2] }, { text: "走到哪一步了", group_id: [2, 2] },
      { text: "工具已经成熟了", group_id: [1, 2] }, { text: "但会深度用它的人还很少", group_id: [2, 2] },
    ]).slice(2)).toEqual([
      "AI现在，走到哪一步了", "AI现在，走到哪一步了",
      "AI现在，走到哪一步了，工具已经成熟了，但会深度用它的人还很少",
      "AI现在，走到哪一步了，工具已经成熟了，但会深度用它的人还很少",
    ]);
  });

  it("keeps malformed or incomplete groups local instead of swallowing later segments", () => {
    expect(segmentRecallContexts([
      { text: "甲", group_id: [1, 99] }, { text: "乙", group_id: [2, 3] }, { text: "丙", group_id: [] },
    ])).toEqual(["甲", "甲，乙", "乙，丙"]);
  });
});
