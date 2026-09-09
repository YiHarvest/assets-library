import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeDatabase } from "@/server/db/migrations";
import type { DatabaseConnection } from "@/server/db/connection";
import { privateAssets, publicAssets, users } from "@/server/db/schema";
import { buildSearchDocument } from "@/server/search/v2/document";
import { createSearchIndex, ElasticsearchClient } from "@/server/search/v2/elasticsearch";
import { loadSearchBuildRuntime } from "@/server/search/v2/runtime";
import { writeSearchDocument } from "@/server/search/v2/writer";
import { manifest as fixture, source } from "../helpers/recall";
import { bindIntegrationDatabaseEnvironment, truncateIntegrationTables } from "../helpers/integration-database";
import identity from "../../config/recall/bge-m3-serving-identity.json";
import descriptor from "../../config/recall/bge-m3-tokenizer.json";

const databaseUrl = process.env.TEST_DATABASE_URL;
const esUrl = process.env.TEST_RECALL_ES_URL;
const embeddingUrl = process.env.TEST_RECALL_EMBEDDING_URL;
const suite = databaseUrl && esUrl && embeddingUrl ? describe : describe.skip;

suite("both business adapters using real v2 recall", () => {
  let database: DatabaseConnection;
  let repository: typeof import("@/server/repositories/assets");
  let singleton: typeof import("@/server/db");
  let client: ElasticsearchClient;
  let created = false;
  const base = `test_adapter_${randomUUID().replaceAll("-", "")}`;
  const manifest = { ...fixture, buildId: randomUUID(), physicalIndex: `${base}_recall_v2_000001`,
    embedding: { ...fixture.embedding, model: "bge-m3", revision: identity.revision, dimensions: 1024,
      tokenizerSha256: descriptor.hashes["tokenizer.json"], tokenizerConfigSha256: descriptor.hashes["tokenizer_config.json"] } };
  beforeAll(async () => {
    bindIntegrationDatabaseEnvironment(databaseUrl!);
    vi.stubEnv("SEARCH_RECALL_ENGINE", "v2");
    vi.stubEnv("ELASTICSEARCH_URL", esUrl!);
    vi.stubEnv("ELASTICSEARCH_USERNAME", process.env.TEST_RECALL_ES_USERNAME ?? "");
    vi.stubEnv("ELASTICSEARCH_PASSWORD", process.env.TEST_RECALL_ES_PASSWORD ?? "");
    vi.stubEnv("DEV_ELASTICSEARCH_INDEX", base);
    vi.stubEnv("EMBEDDING_BASE_URL", embeddingUrl!);
    vi.stubEnv("EMBEDDING_API_KEY", process.env.TEST_RECALL_EMBEDDING_API_KEY ?? "");
    vi.stubEnv("EMBEDDING_MODEL", "bge-m3");
    vi.stubEnv("EMBEDDING_REVISION", identity.revision);
    database = await initializeDatabase({ url: databaseUrl!, poolSize: 4 });
    await truncateIntegrationTables(database.pool);
    client = new ElasticsearchClient({ url: esUrl!, username: process.env.TEST_RECALL_ES_USERNAME,
      password: process.env.TEST_RECALL_ES_PASSWORD, timeoutMs: 30_000 });
    await createSearchIndex(client, manifest);
    created = true;
    await client.request("/_aliases", { method: "POST", body: JSON.stringify({ actions: [{ add: { index: manifest.physicalIndex, alias: `${base}_recall_read` } }] }) });
    repository = await import("@/server/repositories/assets");
    singleton = await import("@/server/db");
  }, 30_000);
  afterAll(async () => {
    try {
      if (created) await client.request(`/${manifest.physicalIndex}`, { method: "DELETE" });
      if (database) { await truncateIntegrationTables(database.pool); await database.pool.end(); }
      if (singleton) await singleton.pool.end();
    } finally { vi.unstubAllEnvs(); }
  });

  it("preserves public/private scope, candidate whitelists and exclusions, and does not expose recall evidence", async () => {
    const now = new Date();
    const [publicId, pendingId, privateId, otherId] = Array.from({ length: 4 }, () => randomUUID());
    await database.db.insert(users).values(["user-a", "user-b"].map((userId) => ({ userId, firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now })));
    const values = { name: "海边日出", description: "海边日出", mediaType: "image" as const, originalFilename: "legacy.png", originalPath: "legacy.png",
      mimeType: "image/png", sizeBytes: 4, processingStatus: "completed" as const, reviewStatus: "published" as const, createdAt: now, updatedAt: now };
    await database.db.insert(publicAssets).values([{ ...values, id: publicId }, { ...values, id: pendingId, reviewStatus: "pending_review" }]);
    await database.db.insert(privateAssets).values([{ ...values, id: privateId, userId: "user-a" }, { ...values, id: otherId, userId: "user-b" }]);
    const runtime = await loadSearchBuildRuntime(manifest);
    for (const id of [publicId, pendingId, privateId, otherId]) {
      await writeSearchDocument(buildSearchDocument({ ...source, id, ...values }, 1, manifest, runtime.tokenizer), manifest, runtime.store, runtime.embed);
    }
    const page = await repository.queryAssetsPage({ semanticQuery: "海边日出" });
    expect(page.items.map((item) => item.id)).toEqual([publicId]);
    expect(page.items[0]).not.toHaveProperty("evidence");
    expect(page.items[0]).not.toHaveProperty("diagnostics");
    const privateResult = await repository.searchAssetsByDescriptionDetailed({ description: "海边日出", limit: 1 }, { userId: "user-a" },
      { candidateAssetIds: [privateId, otherId], isRandom: false, semanticThreshold: 1 });
    expect(privateResult.items.map((item) => item.id)).toEqual([privateId]);
    expect(privateResult.items[0].searchScore).toBe(1);
    const emptyWhitelist = await repository.searchAssetsByDescriptionDetailed({ description: "海边日出", limit: 1 }, { includeAllUsers: true }, { candidateAssetIds: [] });
    expect(emptyWhitelist.items).toEqual([]);
    const excluded = await repository.searchAssetsByDescriptionDetailed({ description: "海边日出", limit: 1 }, { userId: "user-a" }, { excludedAssetIds: [privateId] });
    expect(excluded.items).toEqual([]);
    expect(privateResult.threshold).toBe(0);
  }, 60_000);
});
