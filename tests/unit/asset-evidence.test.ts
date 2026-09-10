import { describe, expect, it } from "vitest";
import { assetEvidence, evidenceInWindow } from "@/server/search/asset-evidence";
import { unusableVisualReason } from "@/server/media/material-quality";

describe("material playback evidence", () => {
  it.each([
    "纯黑色图像，无任何可见内容、物体或细节。",
    "视频全程为黑屏画面，无任何可见视觉内容。",
    "电视测试卡画面，包含彩色条纹、灰度渐变和几何图案，用于信号校准。",
    "视频画面呈现为全黑状态，没有任何可见的视觉内容、人物或场景细节，表现为无信号或黑屏。",
    "画面全黑，没有人物或可见文字。",
    "画面严重模糊，没有任何可辨识的视觉内容。",
    "画面只有随机噪点。",
    "画面全黑。",
  ])("excludes nonvisual filler from an ordinary semantic match: %s", content => {
    expect(unusableVisualReason(content)).toBeTruthy();
    expect(assetEvidence({ description: content, analysis: null, tags: [] }).chunks).toEqual([]);
  });
  it.each([
    "黑屏后出现一名女性，画面没有任何文字。",
    "纯黑背景前是一名疲惫的中年男子。",
    "灰色墙面前的空椅子，没有人物。",
    "黑白剪影中，一个人顶住巨大石块。",
    "蓝色数字人脸，两侧是代码和数据流。",
    "白色背景上显示一行黑色文字。",
    "夜景光线昏暗，街道上只有路灯。",
    "片尾出现短暂黑屏，前段为人物交谈。",
  ])("preserves meaningful scenes and partial black transitions: %s", content => {
    expect(unusableVisualReason(content)).toBeNull();
    expect(assetEvidence({ description: content, analysis: null, tags: [] }).chunks).toHaveLength(1);
  });
  it("does not let edited descriptions hide an unusable analysis", () => {
    expect(assetEvidence({ description: "人生不易", tags: [], analysis: {
      kind: "image", description: "画面全黑，没有任何可见的内容。",
      tags: { scene: [], object: [], person: [], style: [], color_composition: [] },
      ocr: { text: null, unavailableReason: "无文字" },
    } }).chunks).toEqual([]);
  });
  it("keeps late facts out of an early playback window without inventing timestamps", () => {
    const result = assetEvidence({ description: "后半段显示账号异常", tags: [], analysis: {
      kind: "video", description: "旧描述", tags: { scene: [], person: [], form: [] }, topics: [], visualSegments: [],
      timeline: [{ startSeconds: 0, endSeconds: 5, summary: "前段浏览主页，后段显示账号异常" }],
      keyMoments: [{ seconds: 0.2, summary: "手机主页" }, { seconds: 4, summary: "账号异常界面" }],
    } });
    expect(result.chunks.filter(chunk => evidenceInWindow(chunk, 1480)).map(chunk => chunk.content)).toEqual(["手机主页"]);
    expect(result.chunks.filter(chunk => evidenceInWindow(chunk, 5000)).map(chunk => chunk.content))
      .toEqual(["前段浏览主页，后段显示账号异常", "手机主页", "账号异常界面"]);
  });
  it("keeps unknown timing distinct from static images and preserves current tag categories", () => {
    const asset = { description: "现有素材", analysis: null, tags: [{ category: "person", value: "多名成年人" }, { category: "scene", value: "办公室" }] };
    expect(assetEvidence(asset)).toMatchObject({ chunks: [{ kind: "unknown" }], facets: { person: ["多名成年人"], scene: ["办公室"] } });
    expect(evidenceInWindow({ kind: "unknown" }, 440)).toBe(true);
    expect(evidenceInWindow({ kind: "static" }, 440)).toBe(true);
    expect(evidenceInWindow({ kind: "point", startMs: 440 }, 440)).toBe(false);
    expect(evidenceInWindow({ kind: "range", startMs: 0, endMs: 440 }, 440)).toBe(true);
  });
});
