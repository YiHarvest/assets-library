import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../../src/server/config";
import { assetSearchChunks, embedTexts, fuseResults, indexAsset, recallChunks, searchAssets } from "../../src/server/search/elasticsearch";
import { assets, queries } from "./dataset";

// 不导入数据库、仓储或 worker。索引名在本进程内生成，不能指向业务索引。
const index = `asset_threshold_bench_${Date.now()}_${randomUUID().slice(0, 8)}`;
process.env[process.env.APP_MODE === "prd" ? "PRD_ELASTICSEARCH_INDEX" : "DEV_ELASTICSEARCH_INDEX"] = index;
process.env.SEARCH_RERANK_ENABLED = "false";
process.env.SEARCH_SEMANTIC_THRESHOLD = "-1";
process.env.SEARCH_KEYWORD_THRESHOLD = "0";
const config = loadConfig();
assert.equal(config.ELASTICSEARCH_INDEX, index);
const ids = assets.map((asset) => asset.id);
const outputDir = "benchmarks/search/results";
const limit = 8;
type Recall = Awaited<ReturnType<typeof recallChunks>>;
type Sample = typeof queries[number] & { hits: Recall };
type Thresholds = { semantic: number; keyword: number };

async function es(path: string, method = "GET", body?: string) {
  const response = await fetch(`${config.ELASTICSEARCH_URL?.replace(/\/$/, "")}${path}`, {
    method, body,
    headers: {
      ...(body ? { "content-type": "application/x-ndjson" } : {}),
      ...(config.ELASTICSEARCH_USERNAME ? {
      authorization: `Basic ${Buffer.from(`${config.ELASTICSEARCH_USERNAME}:${config.ELASTICSEARCH_PASSWORD ?? ""}`).toString("base64")}`,
      } : {}),
    },
    signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Benchmark ES ${method}: HTTP ${response.status}`);
  return response.json();
}

async function parallel<T, R>(items: T[], action: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await action(items[i], i);
    }
  }));
  const failure = workers.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

function ranked(sample: Sample, thresholds: Thresholds) {
  return fuseResults(
    sample.hits[0].filter((hit) => hit.score >= thresholds.semantic),
    sample.hits[1].filter((hit) => hit.score >= thresholds.keyword),
    config.SEARCH_RRF_K,
  ).map((candidate) => candidate.assetId);
}

function evaluate(samples: Sample[], thresholds: Thresholds, topK = limit) {
  let tp = 0, fp = 0, fn = 0, f1Sum = 0, positives = 0, top1 = 0, absent = 0, falseMatches = 0;
  for (const sample of samples) {
    const returned = ranked(sample, thresholds).slice(0, topK);
    const relevant = new Set(sample.relevant);
    const hits = returned.filter((id) => relevant.has(id)).length;
    tp += hits;
    fp += returned.length - hits;
    fn += relevant.size - hits;
    // 空查询正确返回空记 1 分，错召回记 0；正查询按通常 F1 计算。
    f1Sum += returned.length + relevant.size ? 2 * hits / (returned.length + relevant.size) : 1;
    if (relevant.size) {
      positives++;
      if (relevant.has(returned[0])) top1++;
    } else {
      absent++;
      if (returned.length) falseMatches++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    queries: samples.length, tp, fp, fn, precision, recall,
    microF1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    macroF1: f1Sum / samples.length,
    top1Accuracy: positives ? top1 / positives : 0,
    noMatchQueries: absent, noMatchFalsePositiveRate: absent ? falseMatches / absent : 0,
  };
}

function range(from: number, to: number, step: number) {
  return Array.from({ length: Math.floor((to - from) / step + 1e-6) + 1 }, (_, i) => Number((from + i * step).toFixed(4)));
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const version = (await es("/")).version.number;
  let created = false;
  try {
    // indexAsset 复用真实分块、embedding、mapping 和写入流程。
    created = true;
    await indexAsset(assets[0]);
    const documents = assets.slice(1).flatMap((asset) => assetSearchChunks(asset).map((content, i) => ({
      id: `${asset.id}:${i}`, assetId: asset.id, content,
    })));
    const batches = Array.from({ length: Math.ceil(documents.length / 16) }, (_, i) => documents.slice(i * 16, i * 16 + 16));
    const vectors = (await parallel(batches, (batch) => embedTexts(batch.map((doc) => doc.content)))).flat();
    const bulk = documents.flatMap((doc, i) => [
      { index: { _id: doc.id } }, { assetId: doc.assetId, content: doc.content, embedding: vectors[i] },
    ]).map((line) => JSON.stringify(line)).join("\n") + "\n";
    assert.equal((await es(`/${index}/_bulk?refresh=true`, "POST", bulk)).errors, false);
    console.log(`Indexed ${assets.length} synthetic assets`);
    const expectedChunks = assets.flatMap(assetSearchChunks).length;
    const count = await es(`/${index}/_count`);
    assert.equal(count.count, expectedChunks);
    const samples: Sample[] = await parallel(queries, async (query, i) => {
      const hits = await recallChunks(query.text, ids);
      if ((i + 1) % 16 === 0) console.log(`Recalled ${i + 1}/${queries.length} synthetic queries`);
      return { ...query, hits };
    });
    await writeFile(`${outputDir}/recalls.json`, JSON.stringify(samples, null, 2) + "\n");
    const tune = samples.filter((sample) => sample.split === "tune");
    const test = samples.filter((sample) => sample.split === "test");
    assert.equal(new Set(tune.map((q) => q.topic).filter((topic) => test.some((q) => q.topic === topic))).size, 0);
    // 只使用 tune 的分数范围/标签选择阈值；test 在选定之后才计算指标。
    const maxBm25 = Math.ceil(Math.max(...tune.flatMap((sample) => sample.hits[1].map((hit) => hit.score)))) + 1;
    let best: Thresholds = { semantic: -1, keyword: 0 };
    let bestMetrics = evaluate(tune, best);
    const trials: Array<Thresholds & { macroF1: number }> = [];
    const searchGrid = (semanticValues: number[], keywordValues: number[]) => {
      for (const semantic of semanticValues) for (const keyword of keywordValues) {
        const thresholds = { semantic, keyword };
        const metrics = evaluate(tune, thresholds);
        trials.push({ ...thresholds, macroF1: metrics.macroF1 });
        if (metrics.macroF1 > bestMetrics.macroF1 + 1e-12 ||
          (Math.abs(metrics.macroF1 - bestMetrics.macroF1) < 1e-12 &&
            (metrics.noMatchFalsePositiveRate < bestMetrics.noMatchFalsePositiveRate ||
              (metrics.noMatchFalsePositiveRate === bestMetrics.noMatchFalsePositiveRate &&
                (semantic < best.semantic || (semantic === best.semantic && keyword < best.keyword)))))) {
          best = thresholds;
          bestMetrics = metrics;
        }
      }
    };
    searchGrid([-1, ...range(0, 1, 0.025)], range(0, maxBm25, 1));
    const coarse = { ...best };
    searchGrid(range(Math.max(0, coarse.semantic - 0.025), Math.min(1, coarse.semantic + 0.025), 0.005),
      range(Math.max(0, coarse.keyword - 1), coarse.keyword + 1, 0.25));
    console.log(`Selected on tune only: cosine >= ${best.semantic}, BM25 >= ${best.keyword}`);

    // 重新调用真实检索，验证离线过滤重放和 ES 阈值执行的素材、排序、RRF 分数一致。
    process.env.SEARCH_SEMANTIC_THRESHOLD = String(best.semantic);
    process.env.SEARCH_KEYWORD_THRESHOLD = String(best.keyword);
    await parallel(samples, async (sample) => {
      const actual = await searchAssets(sample.text, ids);
      assert.deepEqual(actual.map((item) => item.assetId), ranked(sample, best), `Replay mismatch: ${sample.id}`);
      const expected = fuseResults(sample.hits[0].filter((hit) => hit.score >= best.semantic),
        sample.hits[1].filter((hit) => hit.score >= best.keyword), config.SEARCH_RRF_K);
      actual.forEach((item, i) => assert.ok(Math.abs(item.searchScore - expected[i].searchScore) < 1e-8));
    });
    const baseline = { semantic: -1, keyword: 0 };
    const variants = [
      ["no-threshold", baseline], ["selected", best],
      ["selected-semantic-only", { semantic: best.semantic, keyword: Infinity }],
      ["selected-keyword-only", { semantic: Infinity, keyword: best.keyword }],
    ] as const;
    const scores = Object.fromEntries(variants.map(([name, thresholds]) => [name, {
      tune: evaluate(tune, thresholds), test: evaluate(test, thresholds),
    }]));
    const report = {
      generatedAt: new Date().toISOString(), corpusVersion: 1, source: "synthetic-only; no database access",
      model: config.EMBEDDING_MODEL, dimensions: (await es(`/${index}/_mapping`))[index].mappings.properties.embedding.dims,
      elasticsearch: version, analyzer: config.ELASTICSEARCH_ANALYZER,
      assetCount: assets.length, chunkCount: expectedChunks, queryCount: queries.length,
      tuneTopics: [...new Set(tune.map((q) => q.topic))], testTopics: [...new Set(test.map((q) => q.topic))],
      vectorTopK: config.SEARCH_VECTOR_TOP_K, keywordTopK: config.SEARCH_KEYWORD_TOP_K,
      numCandidates: Math.max(config.SEARCH_VECTOR_TOP_K, config.SEARCH_NUM_CANDIDATES), rrfK: config.SEARCH_RRF_K,
      evaluationTopK: limit, objective: "macro F1@8; empty/empty = 1, no-match false recall = 0",
      tieBreak: "lower no-match false positive rate, then lower semantic and keyword thresholds",
      selected: best, trials: trials.length, scores,
      testByKind: Object.fromEntries(["keyword", "description", "no_match"].map((kind) =>
        [kind, evaluate(test.filter((q) => q.kind === kind), best)])),
      testByLimit: Object.fromEntries([1, 5, 8, 20, 200].map((k) => [k, evaluate(test, best, k)])),
      liveReplayQueries: samples.length,
      errors: test.map((sample) => ({
        query: sample.text, expected: sample.relevant, returned: ranked(sample, best).slice(0, limit),
      })).filter((row) => row.returned.some((id) => !row.expected.includes(id)) || row.expected.some((id) => !row.returned.includes(id))),
    };
    await writeFile(`${outputDir}/report.json`, JSON.stringify(report, null, 2) + "\n");
    await writeFile(`${outputDir}/grid.json`, JSON.stringify(trials) + "\n");
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const rows = Object.entries(scores).flatMap(([name, splits]) => Object.entries(splits).map(([split, m]) =>
      `| ${name} | ${split} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.macroF1)} | ${pct(m.top1Accuracy)} | ${pct(m.noMatchFalsePositiveRate)} |`));
    await writeFile(`${outputDir}/report.md`, `# 合成素材召回阈值 benchmark\n\n` +
      `生成时间：${report.generatedAt}\n\n模型：${report.model}；向量维度：${report.dimensions}；ES ${version}；分析器：${report.analyzer}。\n\n` +
      `${assets.length} 条素材，${expectedChunks} 个分块；调参集 ${tune.length} 条查询，独立测试集 ${test.length} 条查询，按主题分割。\n\n` +
      `推荐：\n\n\`\`\`dotenv\nSEARCH_SEMANTIC_THRESHOLD=${best.semantic}\nSEARCH_KEYWORD_THRESHOLD=${best.keyword}\n\`\`\`\n\n` +
      `阈值在分块 RRF 前分别生效，任一路过线即可入选。主指标为最终素材 macro F1@8；正负样本比例 3:1，空集正确拒绝记 1 分。Precision/Recall 为包含无匹配查询的微平均，Top-1 为正查询首位命中率。\n\n` +
      `仅在调参集搜索 ${trials.length} 对阈值；粗网格余弦步长 0.025、BM25 步长 1，局部细化为 0.005 / 0.25。同分优先较少误召回，再选较低阈值。默认召回窗口 ${config.SEARCH_VECTOR_TOP_K}/${config.SEARCH_KEYWORD_TOP_K}，RRF k=${config.SEARCH_RRF_K}，rerank 关闭。\n\n` +
      `| 方案 | 集合 | Precision@8 | Recall@8 | Macro F1@8 | Top-1 | 无匹配误召回率 |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\n` +
      `所有 ${samples.length} 条查询均用真实 ES 阈值重新检索，并与离线重放逐项核对素材顺序与 RRF 分数。\n\n` +
      `## 适用范围与限制\n\n完全合成数据，未读取任何业务数据库。标签由场景主体、动作和环境定义，每个正查询对应两条素材；没有以待测分数生成标签。查询与标注均由同一助手编写，仍存在表达和标注偏差。测试集只有 ${test.length} 条查询，不能视为业务效果保证。\n\n` +
      `这是本次模型、standard/当前分析器、小语料和配置下搜索到的最佳网格点，不是跨模型/跨数据集的普遍最优阈值。BM25 受查询长度和语料词频影响；更换模型、分析器或扩大语料后应重新评估。未测试真实用户权限分布、线上延迟或真实视频的视觉相关性。\n\n` +
      `详见 report.json 的测试集分类结果、不同返回条数、误召回明细；recalls.json 保存未过滤的原始两路候选，grid.json 保存调参轨迹。\n`);
    console.log(JSON.stringify({ selected: best, scores, liveReplayQueries: samples.length, report: `${outputDir}/report.md` }));
  } finally {
    if (created) {
      await es(`/${index}`, "DELETE");
      console.log(`Removed temporary synthetic index ${index}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
