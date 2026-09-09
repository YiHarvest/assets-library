import { canonicalJson, compareText, fingerprint, hashText, normalizeSearchText } from "./fingerprint";
import type { SearchAssetSource, SearchBuildManifest, SearchChunk, SourceRef, TextTokenizer } from "./types";
import { AppError } from "@/server/errors";

function splitText(text: string, manifest: SearchBuildManifest, tokenizer: TextTokenizer, paragraphEnds: Set<number>) {
  const { targetTokens, maxTokens, overlapTokens } = manifest.chunker;
  if (tokenizer.count(text) <= maxTokens) return [{ text }];
  const points = Array.from(text);
  const windows: Array<{ text: string; startChar?: number; endChar?: number }> = [];
  let start = 0;
  while (start < points.length) {
    let low = start + 1;
    let high = points.length;
    let end = start;
    // Slice original Unicode, then measure real tokens. Decoding token IDs would lose
    // unknown characters and SentencePiece-normalized spelling in the source evidence.
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (tokenizer.count(points.slice(start, middle).join("")) <= targetTokens) {
        end = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (end === start) throw new AppError("invalid_request", "分块 token 预算无法容纳单个字符。", 422);
    if (end < points.length) {
      const minimum = start + Math.floor((end - start) / 2);
      const sentenceEnd = points.slice(minimum, end).findLastIndex((char, offset) =>
        /[。！？!?；;]/u.test(char) || paragraphEnds.has(minimum + offset + 1));
      if (sentenceEnd >= 0) end = minimum + sentenceEnd + 1;
    }
    const part = points.slice(start, end).join("").trim();
    if (part) {
      if (tokenizer.count(part) > maxTokens) throw new AppError("invalid_request", "分块超过模型 token 上限。", 422);
      windows.push({ text: part, startChar: start, endChar: end });
      if (windows.length > manifest.chunker.maxChunks) throw new AppError("invalid_request", "素材检索块数超过配置上限。", 422);
    }
    if (end === points.length) break;
    let next = end;
    const specials = tokenizer.count("");
    // Keep overlap within budget, with at least one new source character per window.
    while (next > start + 1 && tokenizer.count(points.slice(next - 1, end).join("")) - specials <= overlapTokens) next--;
    start = next;
  }
  return windows;
}

export function buildSearchChunks(source: SearchAssetSource, manifest: SearchBuildManifest, tokenizer: TextTokenizer): SearchChunk[] {
  if (!["visual-v2", "legacy-v1"].includes(manifest.chunker.version)) throw new AppError("invalid_request", "不支持的召回分块版本。", 422);
  const sources: Array<{ text: string; ref: SourceRef }> = [{ text: source.description, ref: { field: "description" } }];
  if (source.analysis?.kind === "video") {
    for (const field of ["timeline", "visualSegments"] as const) {
      for (const item of source.analysis[field]) sources.push({ text: item.summary,
        ref: { field, startSeconds: item.startSeconds, endSeconds: item.endSeconds } });
    }
    for (const item of source.analysis.keyMoments) sources.push({ text: item.summary,
      ref: { field: "keyMoments", startSeconds: item.seconds } });
  }
  const byText = new Map<string, { text: string; sourceRefs: Map<string, SourceRef> }>();
  for (const source of sources) {
    if (manifest.chunker.version === "legacy-v1") {
      // Controlled ablation: exact v1 trim/dedup semantics, one whole description
      // or summary per chunk. Oversized legacy inputs fail rather than truncate.
      const text = source.text.trim();
      if (!text) continue;
      if (tokenizer.count(text) > manifest.chunker.maxTokens) throw new AppError("invalid_request", "旧分块对照输入超过 token 上限。", 422);
      const chunk = byText.get(text) ?? { text, sourceRefs: new Map<string, SourceRef>() };
      chunk.sourceRefs.set(canonicalJson(source.ref), source.ref);
      byText.set(text, chunk);
      if (byText.size > manifest.chunker.maxChunks) throw new AppError("invalid_request", "素材检索块数超过配置上限。", 422);
      continue;
    }
    const paragraphs = source.text.split(/\r\n?|\n/u).map(normalizeSearchText).filter(Boolean);
    const text = paragraphs.join(" ");
    if (!text) continue;
    const paragraphEnds = new Set<number>();
    let offset = 0;
    for (const paragraph of paragraphs) {
      offset += Array.from(paragraph).length;
      paragraphEnds.add(offset);
      offset++;
    }
    for (const part of splitText(text, manifest, tokenizer, paragraphEnds)) {
      const ref: SourceRef = "startChar" in part ? { ...source.ref, sourceHash: hashText(text),
        startChar: part.startChar, endChar: part.endChar } : source.ref;
      const chunk = byText.get(part.text) ?? { text: part.text, sourceRefs: new Map<string, SourceRef>() };
      chunk.sourceRefs.set(canonicalJson(ref), ref);
      byText.set(part.text, chunk);
      if (byText.size > manifest.chunker.maxChunks) throw new AppError("invalid_request", "素材检索块数超过配置上限。", 422);
    }
  }
  return [...byText.values()].map(({ text, sourceRefs }) => {
    const refs = [...sourceRefs.entries()].sort(([a], [b]) => compareText(a, b)).map(([, ref]) => ref);
    const textHash = hashText(text);
    return { chunkId: fingerprint({ chunker: manifest.chunker, textHash, sourceRefs: refs }),
      text, textHash, sourceRefs: refs, tokenCount: tokenizer.count(text) };
  }).sort((a, b) => compareText(a.chunkId, b.chunkId));
}
