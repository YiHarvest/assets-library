import { readFile } from "node:fs/promises";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import { auditLog } from "@/server/observability/audit-log";
import { ElasticsearchClient, parseSearchIndexMetadata } from "./elasticsearch";
import { loadSearchBuildRuntime } from "./runtime";
import { recallAssets } from "./recall";
import { parseRecallPolicy } from "./policy";

export async function resolveRecallManifest(request: (path: string) => Promise<Response>, baseIndex: string) {
  const alias = `${baseIndex}_recall_read`;
  const response = await request(`/${encodeURIComponent(alias)}?features=aliases,mappings`);
  const bindings = await response.json();
  const indices = Object.keys(bindings);
  if (indices.length !== 1) throw new AppError("storage_error", "召回读别名必须指向唯一物理索引。", 503);
  const index = indices[0];
  if (!index.startsWith(`${baseIndex}_recall_v2_`)) throw new AppError("storage_error", "召回读索引不属于当前环境。", 503);
  const options = bindings[index]?.aliases?.[alias];
  if (!options || options.filter || options.routing || options.search_routing || options.index_routing) {
    throw new AppError("storage_error", "召回读别名不能带过滤或路由配置。", 503);
  }
  return parseSearchIndexMetadata(bindings, index);
}

export async function searchWithV2(query: string, assetIds: string[], revalidate?: (assetIds: string[]) => Promise<string[]>, context?: string) {
  const config = loadConfig();
  let policy;
  try { policy = parseRecallPolicy(JSON.parse(await readFile(config.SEARCH_V2_POLICY_PATH, "utf8"))); }
  catch { throw new AppError("storage_error", "召回策略配置缺失或无效。", 503); }
  const result = await recallAssets({ query, context, eligibleAssetIds: assetIds }, policy, async () => {
    if (!config.ELASTICSEARCH_URL) throw new AppError("storage_error", "Elasticsearch 服务尚未配置。", 503);
    const client = new ElasticsearchClient({ url: config.ELASTICSEARCH_URL, username: config.ELASTICSEARCH_USERNAME,
      password: config.ELASTICSEARCH_PASSWORD, timeoutMs: config.SEARCH_TIMEOUT_MS });
    const manifest = await resolveRecallManifest(client.request.bind(client), config.ELASTICSEARCH_INDEX);
    const runtime = await loadSearchBuildRuntime(manifest);
    return { manifest, tokenizer: runtime.tokenizer, embed: runtime.embed, request: runtime.client.request.bind(runtime.client) };
  }, revalidate);
  auditLog("asset_recall", { ...result.diagnostics });
  // Evidence and raw scores stay internal; the existing business serializers see
  // exactly the legacy candidate shape and normalized RRF contributions.
  return result.candidates.map((candidate) => ({ assetId: candidate.assetId, searchScore: candidate.searchScore,
    ...(candidate.evidence.vector ? { semanticSimilarity: candidate.evidence.vector.rawScore, matchQuality: candidate.evidence.vector.rawScore } : {}),
    ...(candidate.semanticScore === undefined ? {} : { semanticScore: candidate.semanticScore }),
    ...(candidate.keywordScore === undefined ? {} : { keywordScore: candidate.keywordScore }) }));
}
