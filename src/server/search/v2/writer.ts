import { AppError } from "@/server/errors";
import { fingerprint } from "./fingerprint";
import type { EmbeddedSearchDocument, SearchBuildManifest, SearchDocument } from "./types";

export interface StoredSearchDocument { version: number; document: EmbeddedSearchDocument }
export interface SearchDocumentStore {
  read(assetId: string): Promise<StoredSearchDocument | null>;
  /** Strict ES external version, one full document. A conflict always needs a fresh read. */
  replace(document: EmbeddedSearchDocument): Promise<"written" | "conflict">;
}
export type EmbedSearchTexts = (texts: Array<{ text: string; tokenCount: number }>) => Promise<number[][]>;

export function validVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) && value.some((item) => item !== 0);
}

function existingOutcome(previous: StoredSearchDocument | null, incoming: SearchDocument) {
  if (!previous || previous.version < incoming.sourceRevision) return null;
  if (previous.document.assetId !== incoming.assetId || previous.document.sourceRevision !== previous.version) {
    throw new AppError("storage_error", "索引文档身份或内部版本不一致。", 503);
  }
  if (previous.version > incoming.sourceRevision) return { status: "superseded" as const, observedRevision: previous.version };
  if (previous.document.contentHash !== incoming.contentHash || previous.document.embeddingFingerprint !== incoming.embeddingFingerprint) {
    throw new AppError("storage_error", "相同索引版本的内容指纹不一致。", 503);
  }
  return { status: "unchanged" as const, observedRevision: previous.version };
}

export async function writeSearchDocument(
  document: SearchDocument, manifest: SearchBuildManifest, store: SearchDocumentStore, embed: EmbedSearchTexts,
) {
  if (!Number.isSafeInteger(document.sourceRevision) || document.sourceRevision < 1 ||
    document.embeddingFingerprint !== fingerprint(manifest.embedding)) {
    throw new AppError("storage_error", "索引文档版本或模型指纹不符合目标构建。", 500);
  }
  const previous = await store.read(document.assetId);
  const existing = existingOutcome(previous, document);
  if (existing) return { ...existing, embeddedChunks: 0, reusedChunks: 0 };
  const reusable = new Map<string, number[]>();
  if (previous?.document.assetId === document.assetId && previous.document.embeddingFingerprint === document.embeddingFingerprint) {
    for (const chunk of previous.document.chunks) {
      if (validVector(chunk.embedding, manifest.embedding.dimensions)) reusable.set(chunk.textHash, chunk.embedding);
    }
  }
  const missing = document.chunks.filter((chunk) => !reusable.has(chunk.textHash));
  const vectors = missing.length ? await embed(missing) : [];
  if (vectors.length !== missing.length || vectors.some((vector) => !validVector(vector, manifest.embedding.dimensions))) {
    throw new AppError("model_response_invalid", "Embedding 向量数量、维度或数值无效。", 502);
  }
  missing.forEach((chunk, i) => reusable.set(chunk.textHash, vectors[i]));
  const next: EmbeddedSearchDocument = { ...document, chunks: document.chunks.map((chunk) => ({ ...chunk, embedding: reusable.get(chunk.textHash)! })) };
  const result = await store.replace(next);
  if (result !== "written") {
    const conflict = existingOutcome(await store.read(document.assetId), document);
    if (!conflict) throw new AppError("storage_error", "索引版本冲突后无法确认目标状态。", 503);
    return { ...conflict, embeddedChunks: missing.length, reusedChunks: document.chunks.length - missing.length };
  }
  return { status: "written" as const, observedRevision: document.sourceRevision, embeddedChunks: missing.length, reusedChunks: document.chunks.length - missing.length };
}
