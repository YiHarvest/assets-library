import { canonicalJson, compareText, fingerprint, normalizeSearchText } from "./fingerprint";
import { buildSearchChunks } from "./chunks";
import type { SearchAssetSource, SearchBuildManifest, SearchDocument, TextTokenizer } from "./types";

/** Pure construction from a consistent source snapshot; no media IO or model calls. */
export function buildSearchDocument(
  source: SearchAssetSource, sourceRevision: number, manifest: SearchBuildManifest, tokenizer: TextTokenizer,
): SearchDocument {
  const chunks = buildSearchChunks(source, manifest, tokenizer);
  const tagRefs = [...new Map(source.tags.map((tag) => {
    const value = { category: normalizeSearchText(tag.category), value: normalizeSearchText(tag.value), source: tag.source ?? "model" };
    return [canonicalJson(value), value] as const;
  })).values()].filter((tag) => tag.value).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  const unique = (values: string[]) => [...new Set(values.map(normalizeSearchText).filter(Boolean))].sort(compareText);
  const content = {
    assetId: source.id, schemaVersion: 2 as const, deleted: false,
    embeddingFingerprint: fingerprint(manifest.embedding), chunkerVersion: fingerprint(manifest.chunker),
    name: normalizeSearchText(source.name), exactName: normalizeSearchText(source.name).toLowerCase(),
    humanTags: unique(tagRefs.filter((tag) => tag.source === "human").map((tag) => tag.value)),
    modelTags: unique(tagRefs.filter((tag) => tag.source === "model").map((tag) => tag.value)),
    topics: source.analysis?.kind === "video" ? unique(source.analysis.topics) : [],
    tagRefs, ocr: manifest.includeOcr && source.analysis?.kind === "image" ? normalizeSearchText(source.analysis.ocr.text ?? "") : "",
    parentStartMs: source.segmentStartMs, parentEndMs: source.segmentEndMs, chunks,
  };
  return { ...content, sourceRevision, contentHash: fingerprint(content) };
}

export function buildDeletionDocument(assetId: string, sourceRevision: number, manifest: SearchBuildManifest): SearchDocument {
  const document = buildSearchDocument({
    id: assetId, name: "", description: "", tags: [], analysis: null, segmentStartMs: null, segmentEndMs: null,
  }, sourceRevision, manifest, { count: () => 0 });
  document.deleted = true;
  document.contentHash = fingerprint({ ...document, contentHash: undefined, sourceRevision: undefined });
  return document;
}
