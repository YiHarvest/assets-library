import { describe, expect, it } from "vitest";
import { assetEvidence, evidenceInWindow, permitsVisualMatch } from "@/server/search/asset-evidence";

describe("material playback evidence", () => {
  it.each([
    "纯黑色图像，无任何可见内容、物体或细节。",
    "视频全程为黑屏画面，无任何可见视觉内容。",
    "电视测试卡画面，包含彩色条纹、灰度渐变和几何图案，用于信号校准。",
  ])("excludes nonvisual filler from an ordinary semantic match: %s", content => {
    expect(permitsVisualMatch(content, "生活不容易，只能靠自己")).toBe(false);
  });
  it("keeps explicitly requested blank/test footage and normal dark scenes searchable", () => {
    expect(permitsVisualMatch("视频全程为黑屏画面，无任何可见视觉内容。", "黑屏过渡")).toBe(true);
    expect(permitsVisualMatch("电视测试卡画面", "电视彩条信号校准")).toBe(true);
    expect(permitsVisualMatch("黑屏后出现一名女性，画面没有任何文字。", "女性口播")).toBe(true);
    expect(permitsVisualMatch("纯黑背景前是一名疲惫的中年男子。", "生活压力大")).toBe(true);
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
