import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { openDatabase } from "../src/server/db/connection";
import { analysisResultSchema, type AssetTag } from "../src/shared/contracts";
import { buildSearchDocument } from "../src/server/search/v2/document";
import { loadSearchTokenizer } from "../src/server/search/v2/tokenizer";
import descriptor from "../config/recall/bge-m3-tokenizer.json";
import type { SearchBuildManifest } from "../src/server/search/v2/types";

async function main() {
  assert(process.env.DATABASE_URL, "DATABASE_URL is required");
  // Uses the explicitly configured URL; no mode-based host rewriting or migrations.
  const database = openDatabase({ url: process.env.DATABASE_URL, sslCaPath: process.env.DATABASE_SSL_CA_PATH, poolSize: 1 });
  const connection = await database.pool.getConnection();
  const started = performance.now();
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.query("SET SESSION MAX_EXECUTION_TIME=10000");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const manifest: SearchBuildManifest = { schemaVersion: 2, buildId: "read-only-compatibility-audit", physicalIndex: "audit_recall_v2_unused",
      analyzer: "standard", includeOcr: false, chunker: { version: "visual-v2", targetTokens: 256, maxTokens: 512, overlapTokens: 32, maxChunks: 256 },
      embedding: { model: "bge-m3", revision: descriptor.revision, dimensions: 1024, normalization: "l2", preprocessing: "nfc-whitespace-v1",
        tokenizerSha256: descriptor.hashes["tokenizer.json"], tokenizerConfigSha256: descriptor.hashes["tokenizer_config.json"], maxInputTokens: 8192 } };
    const tokenizer = await loadSearchTokenizer(process.env.RECALL_TOKENIZER_DIR ?? "data/recall-tokenizers/bge-m3", manifest.embedding);
    const [rows] = await connection.query<Array<RowDataPacket & {
      id: string; kind: string; name: string; description: string; processing_status: string;
      segment_start_ms: number | null; segment_end_ms: number | null; result_json: unknown;
    }>>(`SELECT a.id,a.kind,a.name,a.description,a.processing_status,a.segment_start_ms,a.segment_end_ms,r.result_json
      FROM asset_entries a LEFT JOIN analysis_result_entries r ON r.asset_id=a.id AND r.kind=a.kind
      WHERE a.deleted_at IS NULL AND a.review_status<>'deleted' ORDER BY a.id`);
    const [links] = await connection.query<Array<RowDataPacket & { asset_id: string; category: string; value: string; source: "model" | "human" }>>(
      "SELECT a.asset_id,t.category,t.value,a.source FROM asset_tag_entries a INNER JOIN tags t ON t.id=a.tag_id");
    await connection.rollback();
    const tags = new Map<string, AssetTag[]>();
    for (const link of links) tags.set(link.asset_id, [...(tags.get(link.asset_id) ?? []), { category: link.category, value: link.value, source: link.source }]);
    const report = { timestamp: new Date().toISOString(), readOnly: true, activeAssets: rows.length, completed: 0,
      completedDescriptionOnly: 0, failedWithoutChunks: 0, builtDocuments: 0, totalChunks: 0, maximumChunks: 0,
      maximumTokens: 0, mergedSourceReferences: 0, withHumanTags: 0, invalidAnalysis: 0, buildFailures: 0, elapsedMs: 0 };
    for (const row of rows) {
      const parsed = row.result_json === null ? null : analysisResultSchema.safeParse(typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json);
      if (parsed && !parsed.success) { report.invalidAnalysis++; continue; }
      const analysis = parsed?.success ? parsed.data : null;
      try {
        const document = buildSearchDocument({ id: row.id, name: row.name, description: row.description,
          tags: tags.get(row.id) ?? [], analysis, segmentStartMs: row.segment_start_ms, segmentEndMs: row.segment_end_ms }, 1, manifest, tokenizer);
        report.builtDocuments++;
        if (row.processing_status === "completed") {
          report.completed++;
          if (!analysis && document.chunks.length) report.completedDescriptionOnly++;
        }
        if (row.processing_status === "failed" && !document.chunks.length) report.failedWithoutChunks++;
        report.totalChunks += document.chunks.length;
        report.maximumChunks = Math.max(report.maximumChunks, document.chunks.length);
        report.maximumTokens = Math.max(report.maximumTokens, ...document.chunks.map((chunk) => chunk.tokenCount));
        report.mergedSourceReferences += document.chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.sourceRefs.length - 1), 0);
        if (document.humanTags.length) report.withHumanTags++;
      } catch { report.buildFailures++; }
    }
    report.elapsedMs = performance.now() - started;
    if (process.env.RECALL_SOURCE_REPORT) await writeFile(process.env.RECALL_SOURCE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    assert.equal(report.invalidAnalysis + report.buildFailures, 0, "Some current assets cannot be built by v2");
  } finally {
    await connection.rollback();
    connection.release();
    await database.pool.end();
  }
}

main().catch(() => {
  // DB exceptions can contain SQL/data; expose aggregate failures only.
  console.error("Read-only recall source audit failed; no database or index writes were attempted.");
  process.exitCode = 1;
});
