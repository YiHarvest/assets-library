import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { openDatabase } from "../src/server/db/connection";
import { analysisResultSchema, type AssetTag } from "../src/shared/contracts";
import { fingerprint, normalizeSearchText } from "../src/server/search/v2/fingerprint";

/** Read-only staging export. Does not claim labels, independent topic partitions,
 * no-match truth or a frozen test set. Keeps business content in a protected file. */
async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, days: { type: "string", default: "14" } } });
  const days = Number(values.days);
  if (!values.output || !Number.isInteger(days) || days < 1 || days > 30 || !process.env.DATABASE_URL) {
    throw new Error("Usage: export-recall-evaluation-input --output NEW_FILE [--days 14]; explicit DATABASE_URL required");
  }
  const database = openDatabase({ url: process.env.DATABASE_URL, sslCaPath: process.env.DATABASE_SSL_CA_PATH, poolSize: 1 });
  const connection = await database.pool.getConnection();
  try {
    await connection.query("SET SESSION MAX_EXECUTION_TIME=10000");
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const [assets] = await connection.query<Array<RowDataPacket & { id: string; kind: "public" | "private"; video_source_id: string | null;
      name: string; description: string; processing_status: string; review_status: string; segment_start_ms: number | null; segment_end_ms: number | null; result_json: unknown }>>(
      `SELECT a.id,a.kind,a.video_source_id,a.name,a.description,a.processing_status,a.review_status,a.segment_start_ms,a.segment_end_ms,r.result_json
       FROM asset_entries a LEFT JOIN analysis_result_entries r ON r.asset_id=a.id AND r.kind=a.kind
       WHERE a.deleted_at IS NULL AND a.review_status IN ('published','pending_review') ORDER BY a.id LIMIT 65537`);
    if (assets.length > 65536) throw new Error("Source export exceeds asset budget");
    const [links] = await connection.query<Array<RowDataPacket & { asset_id: string; category: string; value: string; source: "human" | "model" }>>(
      "SELECT a.asset_id,t.category,t.value,a.source FROM asset_tag_entries a JOIN tags t ON t.id=a.tag_id ORDER BY t.category,t.value,a.source LIMIT 1000001");
    if (links.length > 1_000_000) throw new Error("Source export exceeds tag budget");
    // Project only fields needed for recall. Callback URLs, ASR words, credentials,
    // signed media URLs and unrelated request metadata never enter the artifact or logs.
    const [jobs] = await connection.query<Array<RowDataPacket & { task_id: string; created_at: Date; segments: unknown; asset_urls: unknown }>>(
      `SELECT task_id,created_at,JSON_EXTRACT(payload,'$.request.llm.segments') AS segments,
       JSON_EXTRACT(payload,'$.request.asset_url_list') AS asset_urls FROM jobs
       WHERE type='match' AND created_at>=UTC_TIMESTAMP()-INTERVAL ? DAY ORDER BY created_at,task_id LIMIT 10001`, [days]);
    if (jobs.length > 10000) throw new Error("Query export exceeds task budget");
    await connection.rollback();
    const tags = new Map<string, AssetTag[]>();
    for (const link of links) {
      const current = tags.get(link.asset_id) ?? [];
      current.push({ category: link.category, value: link.value, source: link.source });
      tags.set(link.asset_id, current);
    }
    const sources = assets.map((asset) => ({ assetId: asset.id, kind: asset.kind,
      sourceGroup: asset.video_source_id ?? asset.id, processingStatus: asset.processing_status, reviewStatus: asset.review_status,
      source: { id: asset.id, name: asset.name, description: asset.description,
        analysis: asset.result_json === null ? null : analysisResultSchema.parse(typeof asset.result_json === "string" ? JSON.parse(asset.result_json) : asset.result_json),
        tags: tags.get(asset.id) ?? [], segmentStartMs: asset.segment_start_ms, segmentEndMs: asset.segment_end_ms } }));
    const allowed = sources.map((source) => source.assetId);
    const currentIds = new Set(allowed);
    const parse = (input: unknown): unknown => typeof input === "string" ? JSON.parse(input) : input;
    const queryMap = new Map<string, { id: string; text: string; entry: "segment-match"; taskGroups: string[]; eligibleAssetIds: string[];
      noMatch: null; poolComplete: false; judgments: never[] }>();
    for (const job of jobs) {
      const segments = parse(job.segments), urls = parse(job.asset_urls);
      if (!Array.isArray(segments)) continue;
      const restricted = Array.isArray(urls) && urls.length > 0;
      const candidateIds = restricted ? [...new Set(urls.flatMap((item: unknown) => {
        const raw = typeof item === "string" ? item : item && typeof item === "object" && "file_url" in item ? item.file_url : null;
        if (typeof raw !== "string") return [];
        try {
          const matched = new URL(raw).pathname.match(/\/api\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
          return matched && currentIds.has(matched[1].toLowerCase()) ? [matched[1].toLowerCase()] : [];
        } catch { return []; }
      }))].sort() : allowed;
      for (const segment of segments) {
        if (!segment || typeof segment.text !== "string" || !normalizeSearchText(segment.text)) continue;
        const key = fingerprint({ text: normalizeSearchText(segment.text), allowed: candidateIds });
        const existing = queryMap.get(key);
        if (existing) { if (!existing.taskGroups.includes(job.task_id)) existing.taskGroups.push(job.task_id); continue; }
        queryMap.set(key, { id: key, text: segment.text, entry: "segment-match", taskGroups: [job.task_id], eligibleAssetIds: candidateIds,
          noMatch: null, poolComplete: false, judgments: [] });
      }
    }
    const artifact = { schemaVersion: 1, stage: "unjudged-input", exportedAt: new Date().toISOString(), windowDays: days,
      sourceSnapshotHash: fingerprint(sources), sources, queries: [...queryMap.values()],
      limitations: ["No assets-query request sample yet; segment-match is only one of the shared entrypoints.",
        "Current source scope is intersected with historical request whitelist; historical per-segment used-ID exclusions are not reconstructed.",
        "Task groups are provenance only, not reviewed topic splits. No visual labels or no-match conclusions have been assigned."] };
    await writeFile(values.output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ readOnly: true, assets: sources.length, sourceGroups: new Set(sources.map((source) => source.sourceGroup)).size,
      tasks: jobs.length, distinctQueriesWithScope: queryMap.size, sourceSnapshotHash: artifact.sourceSnapshotHash, labelsAssigned: 0, frozenTestSet: false }));
  } finally {
    await connection.rollback(); connection.release(); await database.pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Read-only evaluation export failed; no database or index writes were attempted.");
  process.exitCode = 1;
});
