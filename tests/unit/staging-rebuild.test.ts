import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import { assetEvidence } from "@/server/search/asset-evidence";
import { assets } from "../../benchmarks/search/dataset";

const mocks = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, detail: vi.fn(), index: vi.fn(), remove: vi.fn() }));
vi.mock("@/server/db", () => ({ pool: { end: vi.fn() }, db: {
  select: () => ({ from: () => ({ where: () => ({ orderBy: async () => mocks.rows }) }) }),
} }));
vi.mock("@/server/repositories/assets", () => ({ getAssetDetail: mocks.detail }));
vi.mock("@/server/search/elasticsearch", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/search/elasticsearch")>(), indexAsset: mocks.index, deleteAssetIndex: mocks.remove,
}));
import { rebuildSearchStaging } from "../../scripts/rebuild-search-staging";

let directory: string;
let index: string | undefined;
let meta: object;
let documents: number;
let activated: boolean;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "staging-rebuild-"));
  index = undefined; meta = {}; documents = 0; activated = false;
  vi.clearAllMocks();
  vi.stubEnv("APP_MODE", "dev");
  vi.stubEnv("DEV_ELASTICSEARCH_INDEX", "live_dev");
  vi.stubEnv("PRD_ELASTICSEARCH_INDEX", "live_prd");
  vi.stubEnv("ELASTICSEARCH_URL", "https://es.example.test");
  vi.stubEnv("EMBEDDING_BASE_URL", "https://embedding.example.test/v1");
  vi.stubEnv("EMBEDDING_MODEL", "test-embedding");
  mocks.rows = [{ id: assets[0].id }];
  mocks.detail.mockResolvedValue(assets[0]);
  mocks.index.mockImplementation(async asset => {
    index = loadConfig().ELASTICSEARCH_INDEX;
    expect(index).toMatch(/^live_dev_staging_[0-9a-f]{32}$/);
    documents = assetEvidence(asset).chunks.length;
  });
  mocks.remove.mockImplementation(async () => { expect(loadConfig().ELASTICSEARCH_INDEX).toBe(index); documents = 0; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/_resolve/index/")) return Response.json({ indices: [], aliases: activated ? [{ indices: [index] }] : [] });
    if (path === "/live_dev/_mapping") return Response.json({ live_dev: { mappings: { properties: {} } } });
    if (path.endsWith("/_mapping") && init.method === "PUT") {
      expect(path).toBe(`/${index}/_mapping`); meta = JSON.parse(String(init.body))._meta; return Response.json({ acknowledged: true });
    }
    if (path.endsWith("/_search")) return Response.json({ hits: { total: { value: documents } }, aggregations: {
      assets: { value: documents ? 1 : 0 }, evidence: { buckets: [] },
    } });
    return index && path === `/${index}` ? Response.json({ [index]: { settings: { index: { uuid: "isolated-uuid" } }, mappings: { _meta: meta }, aliases: {} } })
      : Response.json({}, { status: 404 });
  }));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it("builds independently, resumes without reembedding unchanged assets and removes deleted assets only from staging", async () => {
  const file = join(directory, "state.json");
  await rebuildSearchStaging(file);
  expect(mocks.index).toHaveBeenCalledTimes(1);
  expect(loadConfig().ELASTICSEARCH_INDEX).toBe("live_dev");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ status: "snapshot_complete", verification: { activeIndexUntouched: true, assets: 1 } });
  await rebuildSearchStaging(file);
  expect(mocks.index).toHaveBeenCalledTimes(1);
  mocks.rows = [];
  await rebuildSearchStaging(file);
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(assets[0].id);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ assets: {}, verification: { documents: 0 } });
  expect(loadConfig().ELASTICSEARCH_INDEX).toBe("live_dev");
});

it("refuses a resumed build once its index is behind a live alias", async () => {
  const file = join(directory, "state.json");
  await rebuildSearchStaging(file);
  activated = true;
  await expect(rebuildSearchStaging(file)).rejects.toThrow("serving live traffic");
  expect(mocks.index).toHaveBeenCalledTimes(1);
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(loadConfig().ELASTICSEARCH_INDEX).toBe("live_dev");
});
