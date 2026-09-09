import { describe, expect, it, vi } from "vitest";
import { buildSearchDocument, buildDeletionDocument } from "@/server/search/v2/document";
import { writeSearchDocument, type SearchDocumentStore } from "@/server/search/v2/writer";
import type { EmbeddedSearchDocument } from "@/server/search/v2/types";
import { manifest, source, tokenizer } from "../helpers/recall";

function memoryStore(initial?: EmbeddedSearchDocument) {
  let document = initial;
  const store: SearchDocumentStore = {
    read: async () => document ? { version: document.sourceRevision, document } : null,
    replace: vi.fn(async (next) => {
      if (document && document.sourceRevision >= next.sourceRevision) return "conflict";
      document = structuredClone(next);
      return "written";
    }),
  };
  return { store, current: () => document };
}

describe("atomic, versioned recall indexing", () => {
  it("retains the old complete version on embedding failure and reuses vectors for metadata-only changes", async () => {
    const { store, current } = memoryStore();
    const embed = vi.fn(async (texts: Array<{ text: string; tokenCount: number }>) => texts.map(() => [1, 0]));
    const first = buildSearchDocument(source, 1, manifest, tokenizer);
    expect(await writeSearchDocument(first, manifest, store, embed)).toMatchObject({ status: "written", embeddedChunks: 1 });
    const renamed = buildSearchDocument({ ...source, name: "新名称" }, 2, manifest, tokenizer);
    expect(await writeSearchDocument(renamed, manifest, store, embed)).toMatchObject({ status: "written", embeddedChunks: 0, reusedChunks: 1 });
    expect(embed).toHaveBeenCalledTimes(1);
    embed.mockRejectedValueOnce(new Error("embedding unavailable"));
    await expect(writeSearchDocument(buildSearchDocument({ ...source, description: "全新内容" }, 3, manifest, tokenizer), manifest, store, embed))
      .rejects.toThrow("embedding unavailable");
    expect(current()?.sourceRevision).toBe(2);
    expect(current()?.chunks[0].text).toBe(source.description);
    expect(store.replace).toHaveBeenCalledTimes(2);
  });

  it("distinguishes idempotent retries, stale work, and same-version content conflicts without embedding", async () => {
    const { store, current } = memoryStore();
    const embed = vi.fn(async () => [[1, 0]]);
    const first = buildSearchDocument(source, 5, manifest, tokenizer);
    await writeSearchDocument(first, manifest, store, embed);
    expect(await writeSearchDocument(first, manifest, store, embed)).toMatchObject({ status: "unchanged", embeddedChunks: 0 });
    expect(await writeSearchDocument(buildSearchDocument({ ...source, description: "旧任务" }, 4, manifest, tokenizer), manifest, store, embed))
      .toMatchObject({ status: "superseded", observedRevision: 5 });
    await expect(writeSearchDocument(buildSearchDocument({ ...source, name: "相同版本不同内容" }, 5, manifest, tokenizer), manifest, store, embed))
      .rejects.toThrow(/版本.*内容/);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(current()?.contentHash).toBe(first.contentHash);
  });

  it("observes a newer tombstone when deletion races with an in-flight embedding", async () => {
    const { store, current } = memoryStore();
    const embed = vi.fn(async () => [[1, 0]]);
    await writeSearchDocument(buildSearchDocument(source, 1, manifest, tokenizer), manifest, store, embed);
    embed.mockImplementationOnce(async () => {
      await writeSearchDocument(buildDeletionDocument(source.id, 3, manifest), manifest, store, embed);
      return [[0, 1]];
    });
    expect(await writeSearchDocument(buildSearchDocument({ ...source, description: "较早的更新" }, 2, manifest, tokenizer), manifest, store, embed))
      .toMatchObject({ status: "superseded", observedRevision: 3 });
    expect(current()).toMatchObject({ sourceRevision: 3, deleted: true, chunks: [] });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("re-embeds changed model fingerprints and rejects malformed dimensions before replacing the document", async () => {
    const { store, current } = memoryStore();
    const embed = vi.fn(async () => [[1, 0]]);
    await writeSearchDocument(buildSearchDocument(source, 1, manifest, tokenizer), manifest, store, embed);
    const changed = { ...manifest, embedding: { ...manifest.embedding, revision: "sha256:" + "d".repeat(64) } };
    await writeSearchDocument(buildSearchDocument(source, 2, changed, tokenizer), changed, store, embed);
    expect(embed).toHaveBeenCalledTimes(2);
    const invalid = vi.fn(async () => [[1, 0, 0]]);
    await expect(writeSearchDocument(buildSearchDocument({ ...source, description: "新文本" }, 3, changed, tokenizer), changed, store, invalid))
      .rejects.toThrow(/维度/);
    expect(current()?.sourceRevision).toBe(2);
  });
});
