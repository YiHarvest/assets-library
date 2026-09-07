import { loadConfig } from "@/server/config";
import type { AnalysisResult } from "@/shared/contracts";

type ChromaCollection = { id: string; name: string };
const semanticSimilarityThreshold = 0.45;

export interface SearchAnalysisOptions {
  /** 调用方需要最终层诊断时可传 0，默认仍保持历史阈值。 */
  minimumSimilarity?: number;
}

function chromaBaseUrl() {
  return loadConfig().CHROMA_URL.replace(/\/$/, "");
}

function chromaDatabasePath() {
  const config = loadConfig();
  return `${chromaBaseUrl()}/api/v2/tenants/${encodeURIComponent(config.CHROMA_TENANT)}/databases/${encodeURIComponent(config.CHROMA_DATABASE)}`;
}

async function chromaRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${chromaDatabasePath()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`Chroma 请求失败：HTTP ${response.status}。`);
  }
  return (await response.json()) as T;
}

async function collection() {
  const config = loadConfig();
  const collections = await chromaRequest<ChromaCollection[]>("/collections?limit=100&offset=0");
  const existing = collections.find((item) => item.name === config.CHROMA_COLLECTION);
  if (existing) return existing;
  try {
    return await chromaRequest<ChromaCollection>("/collections", {
      method: "POST",
      body: JSON.stringify({ name: config.CHROMA_COLLECTION }),
    });
  } catch (error) {
    const refreshed = await chromaRequest<ChromaCollection[]>("/collections?limit=100&offset=0");
    const created = refreshed.find((item) => item.name === config.CHROMA_COLLECTION);
    if (created) return created;
    throw error;
  }
}

async function embed(texts: string[]) {
  const config = loadConfig();
  if (!config.embeddingConfigured || !config.embeddingBaseUrl || !config.EMBEDDING_MODEL) {
    return [];
  }
  const response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}),
    },
    // texts: '天天听人说 天天 天听 听人 人说 ai 大模型 大模 模型 智能体 智能 能体 你是不是一个都没搞懂 你是 是不 不是 是一 一个 个都 都没 没搞 搞懂 又不好意思问 又不 不好 好意 意思 思问 今天十秒钟 今天 天十 十秒 秒钟 用大白话把 用大 大白 白话 话把 ai最常用的五个概念讲清楚 第一 ai 就是让计算机完成识别 就是 是让 让计 计算 算机 机完 完成 成识 识别 判断 生成这类原本需要人来做的事情 生成 成这 这类 类原 原本 本需 需要 要人 人来 来做 做的 的事 事情 第二 大模型 大模 模型 可以理解成经过大量资料训练的通用引擎 可以 以理 理解 解成 成经 经过 过大 大量 量资 资料 料训 训练 练的 的通 通用 用引 引擎 能根据你的 能根 根据 据你 你的'
    body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`Embedding 服务返回 HTTP ${response.status}。`);
  }
  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vectors = payload.data?.map((item) => item.embedding);
  if (!vectors || vectors.length !== texts.length || vectors.some((item) => !item?.length)) {
    throw new Error("Embedding 服务返回无效向量。");
  }
  return vectors as number[][];
}
// 语义检索进行分词
function tokenize(text: string) {
  // 删除首尾空格，将中间连续的多个空格替换为单个空格
  const compact = text.trim().replace(/\s+/g, " ");
  // 匹配连续两个的中文或者字母、Unicode字母、数字、下划线、短横线的连续序列
  /*
  天天听人说AI、大模型、智能体，你是不是一个都没搞懂，又不好意思问？
今天十秒钟，用大白话把AI最常用的五个概念讲清楚？
第一，AI，就是让计算机完成识别、判断、生成这类原本需要人来做的事情。
第二，大模型，可以理解成经过大量资料训练的通用引擎，能根据你的问题组织答案。
第三，提示词，就是你交给AI的任务说明，条件越清楚，结果通常越贴近需求。
第四，智能体，不只会回答，还能围绕目标安排步骤，连续完成任务。
第五，工作流，就是把多个环节按顺序连起来，让前一步的结果接着推动下一步。
这五个概念分开看很抽象，放进流程里就清楚了。建议先收藏，之后遇到相关内容，回来对照着看。
*/
  /* [
  "天天听人说",
  "ai",
  "大模型",
  "智能体",
  "你是不是一个都没搞懂",
  "又不好意思问",
  "今天十秒钟",
  "用大白话把",
  "ai最常用的五个概念讲清楚",
  "第一",
  "ai",
  "就是让计算机完成识别",
  "判断",
  "生成这类原本需要人来做的事情",
  "第二",
  "大模型",
  "可以理解成经过大量资料训练的通用引擎",
  "能根据你的",
]
  */
  const terms = compact.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}_-]+/gu) ?? [];
/*
天天听人说 天天 天听 听人 人说 ai 大模型 大模 模型 智能体 智能 能体 你是不是一个都没搞懂 你是 是不 不是 是一 一个 个都 都没 没搞 搞懂 又不好意思问 又不 不好 好意 意思 思问 今天十秒钟 今天 天十 十秒 秒钟 用大白话把 用大 大白 白话 话把 ai最常用的五个概念讲清楚 第一 ai 就是让计算机完成识别 就是 是让 让计 计算 算机 机完 完成 成识 识别 判断 生成这类原本需要人来做的事情 生成 成这 这类 类原 原本 本需 需要 要人 人来 来做 做的 的事 事情 第二 大模型 大模 模型 可以理解成经过大量资料训练的通用引擎 可以 以理 理解 解成 成经 经过 过大 大量 量资 资料 料训 训练 练的 的通 通用 用引 引擎 能根据你的 能根 根据 据你 你的
*/
  return terms.flatMap((term) => {
    const characters = Array.from(term);
    if (!/^[\p{Script=Han}]+$/u.test(term) || characters.length < 3) return [term];
    // 对三个内容生成二元组
    return [term, ...characters.slice(0, -1).map((_, index) => characters.slice(index, index + 2).join(""))];
  }).join(" ");
}

function analysisPassages(result: AnalysisResult) {
  if (result.kind === "image") {
    return [
      result.description,
      ...Object.entries(result.tags).flatMap(([category, values]) => values.map((value) => `${category} ${value}`)),
      result.ocr.text ?? "",
    ].filter(Boolean);
  }
  return [
    result.description,
    ...result.topics,
    ...Object.entries(result.tags).flatMap(([category, values]) => values.map((value) => `${category} ${value}`)),
    ...result.visualSegments.map((item) => item.summary),
    ...result.keyMoments.map((item) => item.summary),
    ...result.timeline.map((item) => item.summary),
  ].filter(Boolean);
}

export function semanticSearchEnabled() {
  return loadConfig().embeddingConfigured;
}

export async function indexAnalysis(assetId: string, result: AnalysisResult) {
  const passages = analysisPassages(result).map(tokenize).filter(Boolean);
  if (!passages.length) return;
  const vectors = await embed(passages);
  if (!vectors.length) return;
  const target = await collection();
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ where: { assetId } }),
  });
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/upsert`, {
    method: "POST",
    body: JSON.stringify({
      ids: passages.map((_, index) => `${assetId}:${index}`),
      documents: passages,
      embeddings: vectors,
      metadatas: passages.map((_, index) => ({ assetId, chunk: index })),
    }),
  });
}

/** 删除素材对应的全部向量分块；未启用 embedding 时无需访问 Chroma。 */
export async function deleteAnalysis(assetId: string) {
  if (!semanticSearchEnabled()) return;
  const target = await collection();
  await chromaRequest(`/collections/${encodeURIComponent(target.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ where: { assetId } }),
  });
}

export async function searchAnalysis(
  query: string,
  limit: number,
  assetIds?: string[],
  options: SearchAnalysisOptions = {},
) {
  if (!semanticSearchEnabled()) return new Map<string, number>();
  if (assetIds && assetIds.length === 0) return new Map<string, number>();
  // query 向量化,一个向量
  const vectors = await embed([tokenize(query)]);
  if (!vectors.length) return new Map<string, number>();
  const target = await collection();
  // 语义搜索，分数最高的前 limit 个素材
  const result = await chromaRequest<{
    distances?: Array<Array<number | null>>;
    metadatas?: Array<Array<{ assetId?: string } | null>>;
  }>(`/collections/${encodeURIComponent(target.id)}/query`, {
    method: "POST",
    body: JSON.stringify({
      query_embeddings: vectors,
      n_results: limit,
      include: ["metadatas", "distances"],
      ...(assetIds ? { where: { assetId: { $in: assetIds } } } : {}),
    }),
  });
  const minimumSimilarity =
    Math.min(
      1,
      Math.max(0, options.minimumSimilarity ?? semanticSimilarityThreshold),
    );
  const allowedAssetIds = assetIds ? new Set(assetIds) : null;
  // 素材id-> 相似度得分
  const scores = new Map<string, number>();

  for (const [index, metadata] of (result.metadatas?.[0] ?? []).entries()) {
    const assetId = metadata?.assetId;
    const distance = result.distances?.[0]?.[index];
    if (!assetId || distance === null || distance === undefined) continue;
    // 即使向量库错误地忽略了 where，也不能让范围外素材进入上层召回。
    if (allowedAssetIds && !allowedAssetIds.has(assetId)) continue;
    // 1/(1 + distance) 作为相似度得分，越大越好
    const similarity = Math.max(0, Math.min(1, 1 / (1 + distance)));
    if (similarity <= minimumSimilarity) continue;
    scores.set(
      assetId,
      Math.max(scores.get(assetId) ?? 0, similarity),
    );
  }
  return scores;
}
