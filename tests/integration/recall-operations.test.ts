import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeDatabase } from "@/server/db/migrations";
import type { DatabaseConnection } from "@/server/db/connection";
import { ElasticsearchClient } from "@/server/search/v2/elasticsearch";
import { switchRecallAlias } from "@/server/search/v2/switch";
import deployment from "../../config/recall/bge-m3-serving-identity.json";
import { bindIntegrationDatabaseEnvironment, truncateIntegrationTables } from "../helpers/integration-database";

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url && process.env.TEST_RECALL_ES_URL && process.env.TEST_RECALL_EMBEDDING_URL);
(enabled ? describe : describe.skip)("recall operations CLI against isolated MySQL and real ES", () => {
  let connection: DatabaseConnection;
  let directory: string;
  const base = `test_ops_${randomUUID().replaceAll("-", "")}`;
  const physical = `${base}_recall_v2_000001`;
  const client = new ElasticsearchClient({ url: process.env.TEST_RECALL_ES_URL ?? "https://es.example.test", username: process.env.TEST_RECALL_ES_USERNAME,
    password: process.env.TEST_RECALL_ES_PASSWORD, timeoutMs: 30_000 });
  beforeAll(async () => {
    bindIntegrationDatabaseEnvironment(url!);
    connection = await initializeDatabase({ url: url!, sslCaPath: process.env.DATABASE_SSL_CA_PATH || undefined, poolSize: 3 });
    await truncateIntegrationTables(connection.pool);
    directory = await mkdtemp(join(tmpdir(), "recall-ops-test-"));
  }, 30_000);
  afterAll(async () => {
    try {
      await client.request(`/${physical}`, { method: "DELETE" }, [404]);
      await client.request(`/${base}`, { method: "DELETE" }, [404]);
    } finally {
      if (connection) { await truncateIntegrationTables(connection.pool); await connection.pool.end(); }
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  it("prepares, provisions, resumes empty backfill, checks roots, swaps the alias, and verifies rollback without source writes", async () => {
    const manifestPath = join(directory, "manifest.json");
    const environment = { ...process.env, APP_MODE: "dev", DATABASE_URL: url!, DATABASE_SSL_CA_PATH: "",
      DEV_DATABASE_NAME: new URL(url!).pathname.slice(1), DEV_ELASTICSEARCH_INDEX: base,
      ELASTICSEARCH_URL: process.env.TEST_RECALL_ES_URL!, ELASTICSEARCH_USERNAME: process.env.TEST_RECALL_ES_USERNAME ?? "",
      ELASTICSEARCH_PASSWORD: process.env.TEST_RECALL_ES_PASSWORD ?? "", SEARCH_V2_WRITE_ENABLED: "true", SEARCH_RECALL_ENGINE: "v1",
      EMBEDDING_BASE_URL: process.env.TEST_RECALL_EMBEDDING_URL!, EMBEDDING_API_KEY: process.env.TEST_RECALL_EMBEDDING_API_KEY ?? "",
      EMBEDDING_MODEL: deployment.identity.model, EMBEDDING_REVISION: deployment.revision };
    const execute = (script: string, args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", script, ...args],
      { env: environment, timeout: 30_000, maxBuffer: 100_000 });
    await execute("scripts/prepare-recall-build.ts", ["--base-index", base, "--build-id", "000001", "--output", manifestPath]);
    const operation = async (name: string, apply = false) => {
      const output = join(directory, `${name}-${randomUUID()}.json`);
      await execute("scripts/recall-ops.ts", ["--operation", name, "--manifest", manifestPath, "--base-index", base, "--output", output, ...(apply ? ["--apply"] : [])]);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      return JSON.parse(await readFile(output, "utf8"));
    };
    expect(await operation("provision")).toMatchObject({ applied: false });
    expect((await client.request(`/${physical}`, { method: "HEAD" }, [404])).status).toBe(404);
    expect(await operation("provision", true)).toMatchObject({ applied: true });
    expect(await operation("backfill", true)).toMatchObject({ batches: [{ processed: 0, completed: true, cursor: null }] });
    expect(await operation("check")).toMatchObject({ ready: true, parentCount: 0 });
    expect(await switchRecallAlias(client.request.bind(client), base, null, physical)).toMatchObject({ changed: true });
    expect(await switchRecallAlias(client.request.bind(client), base, physical, physical)).toMatchObject({ changed: false });
    await client.request(`/${base}`, { method: "PUT", body: JSON.stringify({ mappings: { properties: { assetId: { type: "keyword" }, content: { type: "text" } } } }) });
    expect(await operation("rollback-check")).toMatchObject({ ready: true, indexedChunks: 0, environmentChanges: { SEARCH_RECALL_ENGINE: "v1" } });
  }, 90_000);
});
