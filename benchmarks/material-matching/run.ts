import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../../src/server/config";
import { pool } from "../../src/server/db";
import { indexAsset, searchAssets, type SearchCandidate } from "../../src/server/search/elasticsearch";
import { matchCompatibilitySegments, type AlignedCompatibilitySegment } from "../../src/server/services/compatibility-match";
import type { AssetDetail, CompatibilityMatchRequest } from "../../src/shared/contracts";

// 输入为脱离业务数据库的快照；只写随机临时 ES 索引，不下载或转码媒体。
interface Fixture {
  assets: Array<AssetDetail & { userId: string | null; segmentStartMs: number; segmentEndMs: number }>;
  tasks: Array<{
    id: string;
    segments: AlignedCompatibilitySegment[];
    assetUrls: CompatibilityMatchRequest["asset_url_list"];
    judgments?: Array<{ segmentId: number; acceptable?: string[]; unacceptable?: string[] }>;
  }>;
}

async function main() {
  const [fixturePath, outputDir = ".run/material-matching/results"] = process.argv.slice(2);
  assert.ok(fixturePath, "Usage: pnpm benchmark:matching <snapshot.json> [output-directory]");
  const fixture: Fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const original = loadConfig();
  assert.equal(original.SEARCH_RECALL_ENGINE, "v1", "This benchmark evaluates v1");
  assert.ok(fixture.assets.length && fixture.tasks.length, "Empty snapshot");
  const index = `asset_matching_bench_${randomUUID().replaceAll("-", "")}`;
  const indexKey = original.APP_MODE === "prd" ? "PRD_ELASTICSEARCH_INDEX" : "DEV_ELASTICSEARCH_INDEX";
  const previous = process.env[indexKey];
  process.env[indexKey] = index;
  assert.equal(loadConfig().ELASTICSEARCH_INDEX, index);
  const reports = [];
  try {
    await mkdir(outputDir, { recursive: true });
    for (const asset of fixture.assets) await indexAsset(asset);
    for (const task of fixture.tasks) {
      const started = Date.now();
      const queries: Array<{ text: string; context?: string; playbackDurationMs?: number; contextRequired?: boolean; short: boolean; candidates: SearchCandidate[] }> = [];
      const segments = await matchCompatibilitySegments(task.segments, "https://replay.invalid", {
        assetUrls: task.assetUrls, isRandom: false,
      }, {
        getAsset: async id => fixture.assets.find(asset => asset.id === id) ?? null,
        search: async (input, _scope, options = {}) => {
          const eligible = fixture.assets.filter(asset => {
            if (options.candidateAssetIds && !options.candidateAssetIds.includes(asset.id)) return false;
            if (options.excludedAssetIds?.includes(asset.id)) return false;
            const duration = asset.segmentEndMs - asset.segmentStartMs;
            return options.shortVideosOnly ? asset.mediaType === "video" && duration > 0 && duration < 2000
              : asset.mediaType === "image" || duration >= (options.minDurationMs ?? 0);
          });
          let candidates = await searchAssets([input.description, ...(input.keywords ?? [])].join(" ").trim(), eligible.map(asset => asset.id), undefined, options.context, options);
          if (options.shortVideosOnly) candidates = candidates.filter(candidate =>
            ((options.contextRequired ? candidate.contextSimilarity : candidate.semanticSimilarity) ?? -1) > 0.5);
          queries.push({ text: input.description, context: options.context, playbackDurationMs: options.playbackDurationMs,
            contextRequired: options.contextRequired, short: !!options.shortVideosOnly, candidates });
          return {
            items: candidates.slice(0, input.limit).map(candidate => ({ ...fixture.assets.find(asset => asset.id === candidate.assetId)!, ...candidate })),
            matchQualities: Object.fromEntries(candidates.filter(candidate => candidate.matchQuality !== undefined).map(candidate => [candidate.assetId, candidate.matchQuality!])),
            playbackEvidence: Object.fromEntries(candidates.filter(candidate => candidate.playbackEvidence).map(candidate => [candidate.assetId, candidate.playbackEvidence!])),
            ...(options.shortVideosOnly ? { shortVideoDurations: Object.fromEntries(eligible.map(asset => [asset.id, asset.segmentEndMs - asset.segmentStartMs])) } : {}),
            threshold: 0, maxScore: candidates.length ? Math.max(...candidates.map(candidate => candidate.searchScore)) : null,
            reason: candidates.length ? "matched" : "no_candidates", message: null,
          };
        },
      });
      const allowed = new Set(task.assetUrls.map(entry => new URL(typeof entry === "string" ? entry : entry.file_url).pathname.split("/").filter(Boolean).at(-1)));
      const used = new Set<string>();
      const selected = new Map<number, string[]>();
      for (const [i, segment] of segments.entries()) {
        const input = task.segments[i];
        for (const [key, value] of Object.entries(input)) assert.deepEqual(segment[key], value, `Changed segment field: ${key}`);
        assert.deepEqual(Object.keys(segment).sort(), [...Object.keys(input), ...["url", "type", "desc", "score", "reason", "message"].map(field => `matched_candidate_${field}`)].sort());
        if (!segment.matched_candidate_url) continue;
        const url = new URL(segment.matched_candidate_url);
        const parts: Array<{ assetId: string }> = url.searchParams.has("concat")
          ? JSON.parse(Buffer.from(url.searchParams.get("concat")!, "base64url").toString())
          : [{ assetId: url.pathname.split("/").at(-1)! }];
        for (const { assetId } of parts) {
          assert.ok(!task.assetUrls.length || allowed.has(assetId), "Outside candidate scope");
          assert.ok(!used.has(assetId), "Source reused");
          used.add(assetId);
        }
        if (url.searchParams.has("clip_ms")) assert.equal(Number(url.searchParams.get("clip_ms")), Math.round((input.end_time - input.start_time) * 1000));
        selected.set(segment.segment_id, parts.map(part => part.assetId));
      }
      const judgments = (task.judgments ?? []).map(judgment => {
        const ids = selected.get(judgment.segmentId) ?? [];
        return { ...judgment, selected: ids, knownBadSelected: ids.some(id => judgment.unacceptable?.includes(id)),
          knownGoodSelected: judgment.acceptable?.length ? ids.some(id => judgment.acceptable!.includes(id)) : null };
      });
      const report = { taskId: task.id, durationMs: Date.now() - started, total: segments.length, matched: selected.size,
        unmatched: segments.length - selected.size, sourceCount: used.size, contractAndTimelinePreserved: true, judgments, result: { segments }, queries };
      reports.push(report);
      await writeFile(`${outputDir}/${task.id}.json`, JSON.stringify(report.result, null, 2) + "\n");
      console.log(JSON.stringify({ taskId: task.id, matched: report.matched, total: report.total, judgments }));
    }
    const files = ["config.ts", "model/analyzer.ts", "search/asset-evidence.ts", "search/elasticsearch.ts", "search/segment-context.ts",
      "services/balanced-asset-assignment.ts", "services/short-video-groups.ts", "services/compatibility-match.ts"];
    const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file =>
      [file, createHash("sha256").update(await readFile(`src/server/${file}`)).digest("hex")])));
    await writeFile(`${outputDir}/report.json`, JSON.stringify({ generatedAt: new Date().toISOString(), fixturePath, sourceHashes,
      engine: original.SEARCH_RECALL_ENGINE, threshold: original.SEARCH_SEMANTIC_THRESHOLD, clip: original.SEGMENT_MATCH_CLIP_ENABLED,
      embeddingModel: original.EMBEDDING_MODEL, execution: "Real embedding and ES; snapshot-backed database; no media rendering or load test",
      limitations: "Judgments are partial review labels, not independent accuracy ground truth. Unknown-time evidence is unverified. RRF is not probability.", reports }, null, 2) + "\n");
  } finally {
    if (previous === undefined) delete process.env[indexKey]; else process.env[indexKey] = previous;
    const response = await fetch(`${original.ELASTICSEARCH_URL?.replace(/\/$/, "")}/${index}`, {
      method: "DELETE", signal: AbortSignal.timeout(original.SEARCH_TIMEOUT_MS), headers: original.ELASTICSEARCH_USERNAME
        ? { authorization: `Basic ${Buffer.from(`${original.ELASTICSEARCH_USERNAME}:${original.ELASTICSEARCH_PASSWORD ?? ""}`).toString("base64")}` } : {},
    });
    assert.ok(response.ok || response.status === 404, `Temporary index cleanup failed: ${index}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
