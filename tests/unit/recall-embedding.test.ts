import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEmbeddingClient } from "@/server/search/v2/embedding";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("bounded v2 embedding requests", () => {
  it("shares concurrency permits across callers and releases them after queued cancellation or service failure", async () => {
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController(); controllers.push(controller); return controller.signal;
    });
    const releases: Array<(response: Response) => void> = [];
    let active = 0, maximum = 0;
    const fetchMock = vi.fn(() => {
      active++; maximum = Math.max(maximum, active);
      return new Promise<Response>((resolve) => releases.push(resolve)).finally(() => { active--; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SearchEmbeddingClient({ baseUrl: "https://embedding.example.test/v1", model: "test", dimensions: 2,
      maxInputTokens: 512, maxBatchTexts: 1, maxBatchTokens: 8, concurrency: 2, timeoutMs: 5000 });
    const input = [{ text: "one", tokenCount: 3 }];
    const first = client.embed(input), second = client.embed(input);
    const canceled = client.embed(input).then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controllers[2].abort();
    expect((await canceled)?.message).toMatch(/等待超时/);
    const response = () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    releases[0](response()); await first;
    const failed = client.embed(input).then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    releases[2](new Response(null, { status: 503 }));
    expect((await failed)?.message).toMatch(/503/);
    const recovered = client.embed(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    releases[3](response()); releases[1](response());
    await Promise.all([second, recovered]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });
  it("respects text and token batch budgets, restores input order, and rejects duplicate indexes", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const input: string[] = JSON.parse(String(init.body)).input;
      return Response.json({ data: input.map((text, index) => ({ index, embedding: [Number(text), 1] })).reverse() });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SearchEmbeddingClient({ baseUrl: "https://embedding.example.test/v1", model: "test", dimensions: 2,
      maxInputTokens: 512, maxBatchTexts: 2, maxBatchTokens: 8, concurrency: 1, timeoutMs: 5_000 });
    const vectors = await client.embed([{ text: "1", tokenCount: 5 }, { text: "2", tokenCount: 5 }, { text: "3", tokenCount: 3 }]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).input)).toEqual([["1"], ["2", "3"]]);
    expect(vectors.map((vector) => vector[0] / vector[1])).toEqual([1, 2, 3]);
    expect(vectors.every((vector) => Math.abs(Math.hypot(...vector) - 1) < 1e-9)).toBe(true);
    fetchMock.mockImplementationOnce(async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }));
    await expect(client.embed([{ text: "1", tokenCount: 3 }, { text: "2", tokenCount: 3 }])).rejects.toThrow(/索引/);
    await expect(client.embed([{ text: "too long", tokenCount: 513 }])).rejects.toThrow(/预算/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
