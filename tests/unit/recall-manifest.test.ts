import { describe, expect, it } from "vitest";
import { parseSearchManifest, searchIndexDefinition } from "@/server/search/v2/manifest";

const manifest = {
  schemaVersion: 2, buildId: "build-1", physicalIndex: "asset_library_dev_recall_v2_000001", analyzer: "standard",
  chunker: { version: "visual-v2", targetTokens: 256, maxTokens: 512, overlapTokens: 32, maxChunks: 256 },
  embedding: { model: "bge-m3", revision: "sha256:" + "c".repeat(64), dimensions: 1024, normalization: "l2", preprocessing: "nfc-whitespace-v1",
    tokenizerSha256: "a".repeat(64), tokenizerConfigSha256: "b".repeat(64), maxInputTokens: 8192 }, includeOcr: false,
};

describe("immutable recall build manifest", () => {
  it("rejects unverifiable model identity, unsafe chunk budgets and ambiguous index targets before IO", () => {
    const build = parseSearchManifest(manifest);
    expect(searchIndexDefinition(build)).toMatchObject({ mappings: {
      dynamic: "strict", _meta: { recall: { manifest: build } }, properties: {
        chunks: { type: "nested", properties: { embedding: { dims: 1024, similarity: "cosine" } } },
      },
    } });
    expect(() => parseSearchManifest({ ...manifest, embedding: { ...manifest.embedding, revision: "bge-m3" } })).toThrow();
    expect(() => parseSearchManifest({ ...manifest, physicalIndex: "asset_library_prd" })).toThrow();
    expect(() => parseSearchManifest({ ...manifest, chunker: { ...manifest.chunker, targetTokens: 513 } })).toThrow();
    expect(() => parseSearchManifest({ ...manifest, chunker: { ...manifest.chunker, maxTokens: 8193 } })).toThrow();
    expect(() => parseSearchManifest({ ...manifest, chunker: { ...manifest.chunker, overlapTokens: 256 } })).toThrow();
  });
});
