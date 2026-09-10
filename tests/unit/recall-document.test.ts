import { describe, expect, it } from "vitest";
import { buildSearchDocument } from "@/server/search/v2/document";
import type { SearchAssetSource } from "@/server/search/v2/types";
import { manifest, source, tokenizer } from "../helpers/recall";
import { parseSearchManifest } from "@/server/search/v2/manifest";

describe("v2 searchable asset document", () => {
  it("turns unusable footage into a tombstone without embedding or lexical content", () => {
    const doc = buildSearchDocument({ ...source, description: "画面全黑，没有任何可见内容。" }, 2, manifest, tokenizer);
    expect(doc).toMatchObject({ assetId: source.id, deleted: true, chunks: [], name: "", modelTags: [], humanTags: [] });
  });
  it("builds a real legacy-chunk ablation with trim-only text and no splitting while preserving independent metadata", () => {
    const legacy = parseSearchManifest({ ...manifest, buildId: "legacy-ablation", physicalIndex: "test_recall_v2_legacy",
      chunker: { ...manifest.chunker, version: "legacy-v1", maxTokens: 8192, overlapTokens: 0 },
      embedding: { ...manifest.embedding, preprocessing: "trim-v1" } });
    const sample = { ...source, description: `  cafe\u0301\n\n${"海边 ".repeat(400)}  ` };
    const old = buildSearchDocument(sample, 1, legacy, tokenizer);
    const current = buildSearchDocument(sample, 1, manifest, tokenizer);
    expect(old.chunks).toHaveLength(1);
    expect(old.chunks[0].text).toBe(sample.description.trim());
    expect(current.chunks.length).toBeGreaterThan(1);
    expect(old.name).toBe(current.name);
    expect(old.embeddingFingerprint).not.toBe(current.embeddingFingerprint);
    expect(() => parseSearchManifest({ ...legacy, embedding: manifest.embedding })).toThrow();
  });
  it("indexes an existing description-only asset without media references or analysis", () => {
    const document = buildSearchDocument(source, 1, manifest, tokenizer);
    expect(document).toMatchObject({ assetId: source.id, schemaVersion: 2, sourceRevision: 1, deleted: false,
      name: "旧素材", chunks: [{ text: "海边日出", tokenCount: 6, sourceRefs: [{ field: "description" }] }] });
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(document.chunks[0].chunkId).toMatch(/^[a-f0-9]{64}$/);
    expect(document.chunks[0]).not.toHaveProperty("embedding");
  });

  it("merges repeated summaries without losing times and keeps IDs stable after unrelated insertions", () => {
    const video: SearchAssetSource = { ...source, segmentStartMs: 50_000, segmentEndMs: 90_000, analysis: {
      kind: "video", description: "旧描述不能覆盖当前人工描述", topics: [], tags: { scene: [], person: [], form: [] },
      timeline: [{ startSeconds: 1, endSeconds: 3, summary: "同一个人在海边" }],
      visualSegments: [{ startSeconds: 10, endSeconds: 12, summary: "同一个人在海边" }],
      keyMoments: [{ seconds: 20, summary: "同一个人在海边" }],
    } };
    const document = buildSearchDocument(video, 2, manifest, tokenizer);
    expect(document.chunks.map((chunk) => chunk.text).sort()).toEqual(["同一个人在海边", "海边日出"].sort());
    const repeated = document.chunks.find((chunk) => chunk.text === "同一个人在海边")!;
    expect(repeated.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "timeline", startSeconds: 1, endSeconds: 3 }),
      expect.objectContaining({ field: "visualSegments", startSeconds: 10, endSeconds: 12 }),
      expect.objectContaining({ field: "keyMoments", startSeconds: 20 }),
    ]));
    expect(document.parentStartMs).toBe(50_000);
    if (video.analysis?.kind !== "video") throw new Error("Invalid fixture");
    video.analysis.timeline.unshift({ startSeconds: 0, endSeconds: 1, summary: "新增不相关的开头" });
    expect(buildSearchDocument(video, 3, manifest, tokenizer).chunks.find((chunk) => chunk.text === repeated.text)?.chunkId)
      .toBe(repeated.chunkId);
  });

  it("bounds long text with the supplied tokenizer and covers every character without truncation", () => {
    const description = Array.from({ length: 200 }, (_, i) => `第${i}段。没有汽车，👩🏽‍💻在海边。`).join("");
    const limited = { ...manifest, chunker: { ...manifest.chunker, targetTokens: 32, maxTokens: 48, overlapTokens: 4, maxChunks: 256 } };
    const document = buildSearchDocument({ ...source, description }, 1, limited, tokenizer);
    expect(document.chunks.length).toBeGreaterThan(1);
    const points = Array.from(description);
    const covered = new Set<number>();
    for (const chunk of document.chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(48);
      expect(chunk.tokenCount).toBe(tokenizer.count(chunk.text));
      for (const ref of chunk.sourceRefs) {
        expect(ref.startChar).toBeTypeOf("number");
        expect(ref.endChar).toBeTypeOf("number");
        expect(points.slice(ref.startChar, ref.endChar).join("").trim()).toBe(chunk.text);
        for (let i = ref.startChar!; i < ref.endChar!; i++) covered.add(i);
      }
    }
    expect(covered.size).toBe(points.length);
    expect(() => buildSearchDocument({ ...source, description }, 1,
      { ...limited, chunker: { ...limited.chunker, maxChunks: 2 } }, tokenizer)).toThrow(/块数/);
  });

  it("prefers paragraph boundaries when splitting a long source", () => {
    const paragraphs = ["甲".repeat(20), "乙".repeat(20), "丙".repeat(20)];
    const document = buildSearchDocument({ ...source, description: paragraphs.join("\n") }, 1,
      { ...manifest, chunker: { ...manifest.chunker, targetTokens: 32, maxTokens: 40, overlapTokens: 0 } }, tokenizer);
    expect(document.chunks.map((chunk) => chunk.text).sort()).toEqual([...paragraphs].sort());
  });

  it("keeps names and current tag provenance lexical-only and excludes rejected analysis tags and OCR by default", () => {
    const metadata: SearchAssetSource = { ...source, name: "  Launch Ａ 2026 ", tags: [
      { category: "scene", value: "海边", source: "human" },
      { category: "object", value: "帆船", source: "model" },
    ], analysis: { kind: "image", description: "过时的模型描述", tags: { scene: ["已删除的模型标签"], object: [], person: [], style: [], color_composition: [] },
      ocr: { text: "画面文字", unavailableReason: null } } };
    const document = buildSearchDocument(metadata, 1, manifest, tokenizer);
    expect(document).toMatchObject({ name: "Launch Ａ 2026", exactName: "launch ａ 2026", humanTags: ["海边"], modelTags: ["帆船"], ocr: "" });
    expect(document.tagRefs).toHaveLength(2);
    expect(document.tagRefs).toEqual(expect.arrayContaining(metadata.tags));
    expect(document.chunks.map((chunk) => chunk.text)).toEqual(["海边日出"]);
    const changed = buildSearchDocument({ ...metadata, name: "新名称" }, 2, manifest, tokenizer);
    expect(changed.chunks).toEqual(document.chunks);
    expect(changed.contentHash).not.toBe(document.contentHash);
    expect(buildSearchDocument(metadata, 99, manifest, tokenizer).contentHash).toBe(document.contentHash);
    expect(buildSearchDocument(metadata, 1, { ...manifest, includeOcr: true }, tokenizer).ocr).toBe("画面文字");
  });
});
