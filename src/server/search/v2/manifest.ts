import { z } from "zod";
import { fingerprint } from "./fingerprint";
import type { SearchBuildManifest } from "./types";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({
  schemaVersion: z.literal(2), buildId: z.string().min(1).max(191),
  physicalIndex: z.string().max(255).regex(/^[a-z0-9][a-z0-9_-]*_recall_v2_[a-z0-9][a-z0-9_-]*$/),
  analyzer: z.literal("standard"),
  chunker: z.object({ version: z.enum(["visual-v2", "legacy-v1"]), targetTokens: z.number().int().min(8), maxTokens: z.number().int().min(8),
    overlapTokens: z.number().int().min(0).max(32), maxChunks: z.number().int().min(1).max(512) }).strict(),
  embedding: z.object({ model: z.string().min(1), revision: z.string().regex(/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/),
    dimensions: z.number().int().min(1).max(2048), normalization: z.literal("l2"), preprocessing: z.enum(["nfc-whitespace-v1", "trim-v1"]),
    tokenizerSha256: sha256, tokenizerConfigSha256: sha256, maxInputTokens: z.number().int().min(8),
  }).strict(),
  includeOcr: z.boolean(),
  evaluationSourceSnapshotHash: sha256.optional(),
}).strict().superRefine((build, context) => {
  if ((build.chunker.version === "legacy-v1") !== (build.embedding.preprocessing === "trim-v1") ||
    (build.chunker.version === "legacy-v1" && build.chunker.overlapTokens !== 0)) {
    context.addIssue({ code: "custom", message: "旧分块对照必须使用 trim-v1 且不重叠；正式 v2 使用 NFC 空白归一化。" });
  }
  if (build.chunker.targetTokens > build.chunker.maxTokens || build.chunker.maxTokens > build.embedding.maxInputTokens ||
    build.chunker.overlapTokens >= build.chunker.targetTokens - 2) {
    context.addIssue({ code: "custom", path: ["chunker"], message: "分块预算必须满足 overlap < target <= max <= 模型输入上限。" });
  }
});

export function parseSearchManifest(value: unknown): SearchBuildManifest { return schema.parse(value); }

export function searchIndexDefinition(manifest: SearchBuildManifest) {
  const text = { type: "text", analyzer: manifest.analyzer, search_analyzer: manifest.analyzer };
  const exactText = { ...text, fields: { exact: { type: "keyword", normalizer: "recall_exact" } } };
  return {
    settings: { analysis: { normalizer: { recall_exact: { type: "custom", filter: ["lowercase"] } } } },
    mappings: {
      dynamic: "strict", _meta: { recall: { manifest, manifestHash: fingerprint(manifest) } },
      properties: {
        assetId: { type: "keyword" }, schemaVersion: { type: "integer" }, sourceRevision: { type: "long" },
        contentHash: { type: "keyword" }, deleted: { type: "boolean" },
        embeddingFingerprint: { type: "keyword" }, chunkerVersion: { type: "keyword" },
        name: text, exactName: { type: "keyword" }, humanTags: exactText, modelTags: exactText, topics: exactText,
        tagRefs: { type: "object", enabled: false }, ocr: text, parentStartMs: { type: "long" }, parentEndMs: { type: "long" },
        chunks: { type: "nested", properties: {
          chunkId: { type: "keyword" }, text, textHash: { type: "keyword" },
          tokenCount: { type: "integer" }, sourceRefs: { type: "object", enabled: false },
          embedding: { type: "dense_vector", dims: manifest.embedding.dimensions, index: true, similarity: "cosine" },
        } },
      },
    },
  };
}
