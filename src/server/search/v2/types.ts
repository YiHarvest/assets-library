import type { AssetDetail } from "@/shared/contracts";

export type SearchAssetSource = Pick<AssetDetail,
  "id" | "name" | "description" | "analysis" | "tags" | "segmentStartMs" | "segmentEndMs">;

export interface TextTokenizer {
  /** Includes the model's special tokens; never estimates from character count. */
  count(text: string): number;
}

export interface SearchBuildManifest {
  schemaVersion: 2;
  buildId: string;
  physicalIndex: string;
  analyzer: "standard";
  chunker: { version: string; targetTokens: number; maxTokens: number; overlapTokens: number; maxChunks: number };
  embedding: {
    model: string;
    revision: string;
    dimensions: number;
    normalization: "l2";
    preprocessing: "nfc-whitespace-v1" | "trim-v1";
    tokenizerSha256: string;
    tokenizerConfigSha256: string;
    maxInputTokens: number;
  };
  includeOcr: boolean;
  /** Present only for immutable offline corpus builds; live builds follow revisions. */
  evaluationSourceSnapshotHash?: string;
}

export interface SourceRef {
  field: "description" | "timeline" | "visualSegments" | "keyMoments";
  sourceHash?: string;
  startSeconds?: number;
  endSeconds?: number;
  /** Unicode code point offsets in the normalized source text. */
  startChar?: number;
  endChar?: number;
}

export interface SearchChunk {
  chunkId: string;
  text: string;
  textHash: string;
  sourceRefs: SourceRef[];
  tokenCount: number;
}

export interface SearchDocument {
  assetId: string;
  schemaVersion: 2;
  sourceRevision: number;
  contentHash: string;
  deleted: boolean;
  embeddingFingerprint: string;
  chunkerVersion: string;
  name: string;
  exactName: string;
  humanTags: string[];
  modelTags: string[];
  topics: string[];
  tagRefs: Array<{ category: string; value: string; source: "human" | "model" }>;
  ocr: string;
  parentStartMs: number | null;
  parentEndMs: number | null;
  chunks: SearchChunk[];
}

export type EmbeddedSearchDocument = Omit<SearchDocument, "chunks"> & {
  chunks: Array<SearchChunk & { embedding: number[] }>;
};
