import { afterEach, describe, expect, it, vi } from "vitest";
import { indexAnalysis, searchAnalysis } from "@/server/search/chroma";

const originalEnvironment = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnvironment };
});

function configureEmbedding() {
  process.env.CHROMA_URL = "https://your.com";
  process.env.EMBEDDING_BASE_URL = "https://embeddings.test/v1";
  process.env.EMBEDDING_API_KEY = "test-key";
  process.env.EMBEDDING_MODEL = "test-embedding";
}

describe("Chroma analysis index", () => {
  it("segments an analysis result and persists its embeddings to Chroma", async () => {
    configureEmbedding();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        const inputTexts = JSON.parse(String(init?.body)).input as string[];
        return Response.json({
          data: inputTexts.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
        });
      }
      if (url.includes("/collections?")) return Response.json([]);
      if (url.endsWith("/collections")) return Response.json({ id: "collection-id" });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    await indexAnalysis("asset-1", {
      kind: "image",
      description: "科技发布会主视觉",
      tags: {
        scene: ["展厅"],
        object: [],
        person: [],
        style: [],
        color_composition: [],
      },
      ocr: { text: "新品发布", unavailableReason: null },
    });

    const upsert = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/upsert"));
    expect(upsert).toBeDefined();
    expect(String(upsert?.[0])).toContain("/collections/collection-id/upsert");
    const body = JSON.parse(String(upsert?.[1]?.body));
    expect(body.ids).toEqual(["asset-1:0", "asset-1:1", "asset-1:2"]);
    expect(body.metadatas[0]).toEqual({ assetId: "asset-1", chunk: 0 });
    expect(body.documents[0]).toContain("科技发布会主视觉");
  });

  it("converts a keyword embedding query into asset relevance scores", async () => {
    configureEmbedding();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      }
      if (url.includes("/collections?")) return Response.json([{ id: "collection-id", name: "asset_analysis" }]);
      if (url.endsWith("/query")) {
        return Response.json({
          metadatas: [[
            { assetId: "asset-1" },
            { assetId: "asset-1" },
            { assetId: "asset-2" },
            { assetId: "below-threshold" },
          ]],
          distances: [[0.3, 0.1, 1, 1.5]],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const scores = await searchAnalysis("科技活动", 10, ["asset-1", "asset-2"]);
    expect(scores.get("asset-1")).toBeCloseTo(1 / 1.1);
    expect(scores.get("asset-2")).toBeCloseTo(0.5);
    expect(scores.has("below-threshold")).toBe(false);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "/collections/collection-id/query",
    );
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
      where: { assetId: { $in: ["asset-1", "asset-2"] } },
    });
  });
});
