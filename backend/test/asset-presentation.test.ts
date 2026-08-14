import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizedTagCandidates,
  presentAssetTags,
  publicAssetAnalysis,
} from "../src/services/asset-presentation";

test("model tags retain their old category:value presentation", () => {
  assert.deepEqual(
    presentAssetTags(
      [
        { value: "海边", source: "model" },
        { value: "人工标签", source: "human" },
      ],
      { tags: { scene: ["海边"], object: ["帆船"] } },
    ),
    ["scene:海边", "object:帆船", "人工标签"],
  );
});

test("human-only edits do not resurrect model tags from analysis JSON", () => {
  assert.deepEqual(
    presentAssetTags(
      [{ value: "custom:保留", source: "human" }],
      { tags: { scene: ["不应恢复"] } },
    ),
    ["custom:保留"],
  );
});

test("category:value search also recognizes legacy flattened tag rows", () => {
  assert.deepEqual(normalizedTagCandidates("Scene:海边"), ["scene:海边", "海边"]);
  assert.deepEqual(normalizedTagCandidates("海边"), ["海边"]);
});

test("image OCR accepts unavailableReason and preserves multiline text", () => {
  assert.deepEqual(publicAssetAnalysis("image", {
    ocr: { text: null, unavailableReason: "旧模型未提供 OCR" },
  }), {
    ocr: { text: null, unavailable_reason: "旧模型未提供 OCR" },
  });
  assert.deepEqual(publicAssetAnalysis("image", {
    ocr: { text: "第一行\n第二行", unavailable_reason: "ignored" },
  }), {
    ocr: { text: "第一行\n第二行", unavailable_reason: null },
  });
});

test("video analysis accepts legacy camelCase timed fields", () => {
  assert.deepEqual(publicAssetAnalysis("video", {
    topics: ["旅行"],
    visualSegments: [{ startSeconds: 0, endSeconds: 2, summary: "海边" }],
    keyMoments: [{ seconds: 1, summary: "日落" }],
    timeline: [{ startSeconds: 0, endSeconds: 2, summary: "全景" }],
  }), {
    topics: ["旅行"],
    visual_segments: [{ start_seconds: 0, end_seconds: 2, summary: "海边" }],
    key_moments: [{ seconds: 1, summary: "日落" }],
    timeline: [{ start_seconds: 0, end_seconds: 2, summary: "全景" }],
  });
});
