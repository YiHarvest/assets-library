import type { SearchAssetSource, SearchBuildManifest, TextTokenizer } from "@/server/search/v2/types";

// Deterministic test tokenizer; serving-model parity is checked by probe-recall-model.
export const tokenizer: TextTokenizer = { count: (text) => Array.from(text).length + 2 };
export const manifest: SearchBuildManifest = {
  schemaVersion: 2, buildId: "test-build", physicalIndex: "test_recall_v2_000001",
  analyzer: "standard", chunker: { version: "visual-v2", targetTokens: 256, maxTokens: 512, overlapTokens: 32, maxChunks: 256 },
  embedding: { model: "test", revision: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", dimensions: 2, normalization: "l2", preprocessing: "nfc-whitespace-v1",
    tokenizerSha256: "a".repeat(64), tokenizerConfigSha256: "b".repeat(64), maxInputTokens: 8192 },
  includeOcr: false,
};
export const source: SearchAssetSource = {
  id: "legacy-description-only", name: "旧素材", description: "海边日出", analysis: null,
  tags: [], segmentStartMs: null, segmentEndMs: null,
};
