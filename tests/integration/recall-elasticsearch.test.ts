import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ElasticsearchClient, createSearchIndex, searchDocumentStore } from "@/server/search/v2/elasticsearch";
import { buildDeletionDocument, buildSearchDocument } from "@/server/search/v2/document";
import { writeSearchDocument } from "@/server/search/v2/writer";
import { manifest as fixture, source, tokenizer } from "../helpers/recall";
import { recallAssets } from "@/server/search/v2/recall";
import { experimentalRecallPolicy } from "@/server/search/v2/policy";

const endpoint = process.env.TEST_RECALL_ES_URL;
const manifest = { ...fixture, buildId: randomUUID(), physicalIndex: `test_recall_v2_${randomUUID().replaceAll("-", "")}` };
const suite = endpoint ? describe : describe.skip;

suite("v2 indexing against real Elasticsearch", () => {
  let client: ElasticsearchClient;
  let created = false;
  beforeAll(async () => {
    client = new ElasticsearchClient({ url: endpoint!, username: process.env.TEST_RECALL_ES_USERNAME,
      password: process.env.TEST_RECALL_ES_PASSWORD, timeoutMs: 30_000 });
    await createSearchIndex(client, manifest);
    created = true;
  }, 30_000);
  afterAll(async () => {
    if (created) await client.request(`/${manifest.physicalIndex}`, { method: "DELETE" });
  });

  it("replaces complete documents, checks retries, rejects stale resurrection and validates immutable mappings", async () => {
    const store = searchDocumentStore(client, manifest);
    const embed = vi.fn(async (texts: Array<{ text: string }>) => texts.map(() => [1, 0]));
    const first = buildSearchDocument(source, 1, manifest, tokenizer);
    await writeSearchDocument(first, manifest, store, embed);
    expect(await writeSearchDocument(first, manifest, store, embed)).toMatchObject({ status: "unchanged" });
    const renamed = buildSearchDocument({ ...source, name: "new name" }, 2, manifest, tokenizer);
    expect(await writeSearchDocument(renamed, manifest, store, embed)).toMatchObject({ reusedChunks: 1, embeddedChunks: 0 });
    expect((await store.read(source.id))?.document.name).toBe("new name");
    const invalid = { ...(await store.read(source.id))!.document, sourceRevision: 3,
      chunks: [{ ...((await store.read(source.id))!.document.chunks[0]), embedding: [1, 2, 3] }] };
    await expect(store.replace(invalid)).rejects.toThrow();
    expect((await store.read(source.id))?.version).toBe(2);
    await writeSearchDocument(buildDeletionDocument(source.id, 3, manifest), manifest, store, embed);
    expect(await store.replace({ ...(await store.read(source.id))!.document, ...first, chunks: [{ ...first.chunks[0], embedding: [1, 0] }] })).toBe("conflict");
    expect((await store.read(source.id))?.document).toMatchObject({ deleted: true, chunks: [] });
    expect(embed).toHaveBeenCalledTimes(1);
    await expect(createSearchIndex(client, { ...manifest, embedding: { ...manifest.embedding, dimensions: 3 } })).rejects.toThrow(/构建/);
  }, 30_000);

  it("retrieves distinct assets with nested evidence and rejects a semantically opposite name-only match", async () => {
    const store = searchDocumentStore(client, manifest);
    const multiChunk = { ...source, id: "a", analysis: { kind: "video" as const, description: "stale", topics: [],
      tags: { scene: [], person: [], form: [] }, visualSegments: [], keyMoments: [],
      timeline: [{ startSeconds: 0, endSeconds: 1, summary: "第一段海边" }, { startSeconds: 1, endSeconds: 2, summary: "第二段夕阳" }] } };
    for (const asset of [multiChunk, { ...source, id: "b" }, { ...source, id: "c", name: "专用片名", description: "一段森林画面" },
      { ...source, id: "excluded", name: "专用片名" }]) {
      await writeSearchDocument(buildSearchDocument(asset, 1, manifest, tokenizer), manifest, store,
        async (texts) => texts.map(() => asset.id === "c" ? [-1, 0] : asset.id === "b" ? [0.9, 0.1] : [1, 0]));
    }
    await writeSearchDocument(buildDeletionDocument("deleted", 2, manifest), manifest, store, async () => []);
    const embed = vi.fn(async () => [[1, 0]]);
    const dependencies = async () => ({ manifest, tokenizer, embed, request: client.request.bind(client) });
    const result = await recallAssets({ query: "专用片名", eligibleAssetIds: ["a", "b", "c", "deleted"] },
      { ...experimentalRecallPolicy, vectorTopK: 2, lexicalTopK: 2, semanticThreshold: 0.8 }, dependencies);
    expect(result.candidates.map((item) => item.assetId).sort()).toEqual(["a", "b"]);
    expect(result.diagnostics).toMatchObject({ vectorAssets: 2, lexicalAssets: 0 });
    expect(result.candidates.find((item) => item.assetId === "a")?.evidence.vector?.chunkId).toBeTruthy();
    expect(embed).toHaveBeenCalledOnce();
    const lexicalOnly = await recallAssets({ query: "专用片名", eligibleAssetIds: ["c"] },
      { ...experimentalRecallPolicy, vectorEnabled: false }, dependencies);
    expect(lexicalOnly.candidates[0]?.evidence.lexical?.matchedFields).toContain("exact_name");
  }, 30_000);

  it("orders equal vector scores by asset ID rather than index insertion order", async () => {
    const store = searchDocumentStore(client, manifest);
    for (const id of ["tie-z", "tie-a"]) {
      await writeSearchDocument(buildSearchDocument({ ...source, id }, 1, manifest, tokenizer), manifest, store,
        async (texts) => texts.map(() => [1, 0]));
    }
    const result = await recallAssets({ query: "海边", eligibleAssetIds: ["tie-z", "tie-a"] },
      { ...experimentalRecallPolicy, lexicalEnabled: false, vectorTopK: 2 },
      async () => ({ manifest, tokenizer, embed: async () => [[1, 0]], request: client.request.bind(client) }));
    expect(result.candidates.map((candidate) => candidate.assetId)).toEqual(["tie-a", "tie-z"]);
  }, 30_000);

  it("uses context to rank the compatible scene above an isolated focus match, with no context leakage into the result", async () => {
    const store = searchDocumentStore(client, manifest);
    for (const [id, vector] of [["context-phone", [0.9, Math.sqrt(0.19)]], ["focus-phone", [1, 0]]] as const) {
      await writeSearchDocument(buildSearchDocument({ ...source, id }, 1, manifest, tokenizer), manifest, store,
        async (texts) => texts.map(() => [...vector]));
    }
    const input = { query: "手机", context: "店铺获客", eligibleAssetIds: ["context-phone", "focus-phone"] };
    const dependencies = async () => ({ manifest, tokenizer, request: client.request.bind(client),
      embed: async (texts: Array<{ text: string }>) => texts.map(({ text }) => text === "手机" ? [1, 0] : [0, 1]) });
    const policy = { ...experimentalRecallPolicy, lexicalEnabled: false, vectorTopK: 2 };
    const isolated = await recallAssets({ ...input, context: undefined }, policy, dependencies);
    const contextual = await recallAssets(input, policy, dependencies);
    expect(isolated.candidates[0].assetId).toBe("focus-phone");
    expect(contextual.candidates[0].assetId).toBe("context-phone");
    expect(contextual.diagnostics.queryHash).not.toBe(isolated.diagnostics.queryHash);
    expect(contextual.diagnostics).not.toHaveProperty("context");
  }, 30_000);
});
