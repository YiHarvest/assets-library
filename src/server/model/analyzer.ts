import fs from "node:fs/promises";
import {
  loadConfig,
  type AppConfig,
  type ConfiguredModelTarget,
  type ModelProtocol,
  type ModelTarget,
} from "@/server/config";
import { AppError } from "@/server/errors";
import {
  readVideoFrameSet,
  resolveMediaPath,
} from "@/server/media/storage";
import {
  analysisResultSchema,
  type AnalysisResult,
  type MediaType,
} from "@/shared/contracts";
import {
  ModelCandidateCooldowns,
  ModelRequestError,
  modelRequestErrorFromResponse,
} from "./failover";

export interface AnalyzeInput {
  assetId: string;
  mediaType: MediaType;
  mimeType: string;
  relativePath: string;
}

export interface MultimodalAnalyzer {
  analyze(input: AnalyzeInput): Promise<AnalysisOutcome>;
}

export interface AnalysisOutcome {
  result: AnalysisResult;
  model: {
    protocol: ModelProtocol;
    name: string;
  };
}

interface AnalyzerRuntime {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly limit: number) {}

  async run<T>(
    operation: () => Promise<T>,
    deadlineAt: number,
    now: () => number,
  ) {
    await this.acquire(deadlineAt, now);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(deadlineAt: number, now: () => number) {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      return Promise.reject(new ModelDeadlineExceededError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ModelDeadlineExceededError());
        }, remainingMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      // 当前许可直接转交给等待者，active 保持不变。
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

class ModelDeadlineExceededError extends Error {
  constructor() {
    super("Model candidate deadline exceeded.");
    this.name = "ModelDeadlineExceededError";
  }
}

class ModelTargetRequestLimiter {
  private readonly semaphores = new Map<string, AsyncSemaphore>();

  constructor(private readonly limit: number) {}

  run<T>(
    model: ConfiguredModelTarget,
    operation: () => Promise<T>,
    deadlineAt: number,
    now: () => number,
  ) {
    const key = `${model.protocol}\0${model.baseUrl}\0${model.name}`;
    let semaphore = this.semaphores.get(key);
    if (!semaphore) {
      semaphore = new AsyncSemaphore(this.limit);
      this.semaphores.set(key, semaphore);
    }
    return semaphore.run(operation, deadlineAt, now);
  }
}

const imageShape = `{
  "kind":"image",
  "description":"string",
  "tags":{"scene":["string"],"object":["string"],"person":["string"],"style":["string"],"color_composition":["string"]},
  "ocr":{"text":"string or null","unavailableReason":"string or null"}
}`;

const videoShape = `{
  "kind":"video",
  "description":"string",
  "topics":["string"],
  "tags":{"scene":["string"],"person":["string"],"form":["string"]},
  "keyMoments":[{"seconds":0,"summary":"string"}],
  "timeline":[{"startSeconds":0,"endSeconds":1,"summary":"string"}]
}`;

/** 一级分类：每个素材的首标签必须从这五个中选且只选一个（互斥，不可重复）。
 * 展示时逐字呈现，一字不能多也不能少；模型不得改写、缩写、增删字或使用近义词。 */
const PRIMARY_TAG_CATEGORIES = ["城市风貌", "建筑", "科技", "财经", "社会场景"] as const;
const PRIMARY_TAG_SET = new Set<string>(PRIMARY_TAG_CATEGORIES);

function promptFor(mediaType: MediaType, durationSeconds: number | null) {
  const scope =
    mediaType === "video"
      ? "输入是按时间分位采样的关键帧。只分析画面，不分析音轨，不输出 ASR 或语言。根据每帧标注时间生成时间轴，时间必须使用秒。"
      : "识别画面与可见文字；无法识别 OCR 时提供 unavailableReason。";
  return [
    "你是素材库分析器。描述、topics 和所有标签值必须使用简体中文。",
    "每个标签值必须至少包含一个中文汉字；禁止英文标签、拼音和 snake_case。JSON 字段名与标签分类键保持结构中规定的英文。",
    `每个素材必须先确定一个一级分类，从以下五个中选且只选一个：${PRIMARY_TAG_CATEGORIES.join("、")}。`,
    `一级分类必须逐字使用给定词，一字不能多也不能少，禁止改写、缩写、增删字或使用近义词；作为 tags.scene 数组的第一个标签（即整个素材的首标签）。`,
    "其余四个一级分类不得出现在任何其他标签或 topics 中（互斥，不重复）。",
    "每个标签分类最多输出 5 个标签。视频 keyMoments 最多 3 个，timeline 最多 5 段。不要输出 visualSegments，系统会根据 timeline 自动生成。",
    "描述、topics、标签和所有 summary 只能使用简体中文，禁止夹杂英文单词。",
    mediaType === "video"
      ? `视频总时长精确为 ${durationSeconds} 秒。timeline 必须从 0 秒开始、连续覆盖，并精确结束于 ${durationSeconds} 秒。`
      : "",
    mediaType === "video"
      ? "输入只有稀疏关键帧，无法判断慢镜头、长镜头、快镜头、延时摄影、升格、降格或运镜速度；禁止输出这些结论。"
      : "",
    scope,
    "只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。",
    `必须严格符合此结构：${mediaType === "image" ? imageShape : videoShape}`,
  ].filter(Boolean).join("\n");
}

function repairPromptFor(
  mediaType: MediaType,
  invalidText: string,
  correction: string,
  durationSeconds: number | null,
) {
  return [
    "下面是一次素材分析的无效输出。只修复 JSON 结构、中文标签和规定数量，不需要也不得重新分析图片。",
    `修复原因：${correction}`,
    `必须严格符合此结构：${mediaType === "image" ? imageShape : videoShape}`,
    "每个标签分类最多 5 个标签。视频 keyMoments 最多 3 个，timeline 最多 5 段。不要输出 visualSegments。",
    "描述、topics、标签和所有 summary 只能使用简体中文，禁止夹杂英文单词。",
    mediaType === "video"
      ? `视频总时长精确为 ${durationSeconds} 秒；timeline 必须从 0 秒连续覆盖到 ${durationSeconds} 秒。禁止输出无法由关键帧判断的慢镜头、长镜头、快镜头、延时摄影、升格、降格或运镜速度。`
      : "",
    "只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。",
    `待修复输出：${invalidText.slice(0, 12_000)}`,
  ].filter(Boolean).join("\n");
}

const chineseCharacterPattern = /\p{Script=Han}/u;

/**
 * 强制一级分类校验（展示层保证）：
 * - 首标签（tags.scene 的第一个值）必须逐字全等五个一级分类词之一，一字不能多也不能少；
 * - 其余标签与 topics 不得再出现任何一级分类词（互斥、不重复）。
 * 违规抛错后由调用方带 correction 重试；重试仍不合规则分析失败，绝不落库变体。
 */
function requirePrimaryTag(result: AnalysisResult) {
  const scene = result.tags.scene;
  const primary = scene[0];
  if (primary === undefined || !PRIMARY_TAG_SET.has(primary)) {
    throw new Error(
      `首标签（tags.scene 的第一个值）必须逐字等于以下五个一级分类词之一，一字不能多也不能少：${PRIMARY_TAG_CATEGORIES.join("、")}。当前首标签为 ${JSON.stringify(primary ?? null)}。`,
    );
  }
  const remaining = [
    ...scene.slice(1),
    ...Object.entries(result.tags).flatMap(([category, values]) =>
      category === "scene" ? [] : values,
    ),
    ...(result.kind === "video" ? result.topics : []),
  ];
  const duplicates = remaining.filter((label) => PRIMARY_TAG_SET.has(label));
  if (duplicates.length > 0) {
    throw new Error(
      `一级分类互斥：除首标签 "${primary}" 外，其余标签与 topics 不得再出现一级分类词。违规词：${[...new Set(duplicates)].slice(0, 8).join("、")}。`,
    );
  }
  return result;
}

const latinWordPattern = /[A-Za-z]+/;
const unsupportedFrameClaimPattern =
  /慢镜头|慢动作|长镜头|快镜头|延时摄影|升格|降格|推镜头|拉镜头|摇镜头|跟拍|运镜/;

function semanticTexts(result: AnalysisResult) {
  const common = [result.description, ...Object.values(result.tags).flat()];
  if (result.kind === "image") return common;
  return [
    ...common,
    ...result.topics,
    ...result.timeline.map((item) => item.summary),
    ...result.keyMoments.map((item) => item.summary),
  ];
}

function requireChineseText(result: AnalysisResult) {
  const invalidTexts = semanticTexts(result).filter(
    (value) =>
      !chineseCharacterPattern.test(value) || latinWordPattern.test(value),
  );
  if (invalidTexts.length > 0) {
    throw new Error(
      `描述、标签与时间轴文本必须使用简体中文且不得夹杂英文，以下值不合格：${invalidTexts.slice(0, 8).join("、")}`,
    );
  }
  return result;
}

function requireFrameSupportedClaims(result: AnalysisResult) {
  if (result.kind !== "video") return result;
  const unsupported = semanticTexts(result).filter((value) =>
    unsupportedFrameClaimPattern.test(value),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `稀疏关键帧无法支持慢镜头、长镜头或运镜速度等结论，请删除：${unsupported.slice(0, 8).join("、")}`,
    );
  }
  return result;
}

function stripCodeFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function limitArray(value: unknown, maximum: number) {
  return Array.isArray(value) ? value.slice(0, maximum) : value;
}

function normalizedTimeline(value: unknown, durationSeconds: number | null) {
  if (!Array.isArray(value)) return value;
  const limited = value.slice(0, 5);
  if (durationSeconds === null) return limited;
  const duration = Number(durationSeconds.toFixed(3));
  let previousEnd = 0;
  return limited.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const item = entry as Record<string, unknown>;
    if (typeof item.endSeconds !== "number" || !Number.isFinite(item.endSeconds)) {
      return item;
    }
    const startSeconds = index === 0 ? 0 : previousEnd;
    const endSeconds =
      index === limited.length - 1
        ? duration
        : Math.max(
            startSeconds,
            Math.min(duration, Number(item.endSeconds.toFixed(3))),
          );
    previousEnd = endSeconds;
    return { ...item, startSeconds, endSeconds };
  });
}

function normalizedKeyMoments(value: unknown, durationSeconds: number | null) {
  const limited = limitArray(value, 3);
  if (!Array.isArray(limited) || durationSeconds === null) return limited;
  return limited.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const item = entry as Record<string, unknown>;
    if (typeof item.seconds !== "number" || !Number.isFinite(item.seconds)) {
      return item;
    }
    return {
      ...item,
      seconds: Math.max(
        0,
        Math.min(durationSeconds, Number(item.seconds.toFixed(3))),
      ),
    };
  });
}

/**
 * 对模型常见的可恢复偏差做确定性规范化：限制数组长度，并让视频模型只负责
 * timeline；visualSegments 由同一份 timeline 派生，避免重复生成相同语义。
 */
function normalizeAnalysisPayload(
  value: unknown,
  durationSeconds: number | null,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const tags =
    candidate.tags &&
    typeof candidate.tags === "object" &&
    !Array.isArray(candidate.tags)
      ? (candidate.tags as Record<string, unknown>)
      : null;
  if (candidate.kind === "image") {
    return {
      ...candidate,
      ...(tags
        ? {
            tags: Object.fromEntries(
              Object.entries(tags).map(([category, labels]) => [
                category,
                limitArray(labels, 5),
              ]),
            ),
          }
        : {}),
    };
  }
  if (candidate.kind !== "video") return candidate;
  const timelineSource = Array.isArray(candidate.timeline)
    ? candidate.timeline
    : candidate.visualSegments;
  const timeline = normalizedTimeline(timelineSource, durationSeconds);
  return {
    ...candidate,
    ...(tags
      ? {
          tags: Object.fromEntries(
            Object.entries(tags).map(([category, labels]) => [
              category,
              limitArray(labels, 5),
            ]),
          ),
        }
      : {}),
    keyMoments: normalizedKeyMoments(candidate.keyMoments, durationSeconds),
    timeline,
    visualSegments: timeline,
  };
}

function appendUnique(
  labels: readonly string[],
  claimed: Set<string>,
  preserveFirst = false,
) {
  const result: string[] = [];
  for (const [index, label] of labels.entries()) {
    const key = label.trim().toLocaleLowerCase("zh-CN");
    if (preserveFirst && index === 0) {
      result.push(label);
      claimed.add(key);
      continue;
    }
    if (claimed.has(key)) continue;
    claimed.add(key);
    result.push(label);
  }
  return result;
}

function deduplicateTagCategories(result: AnalysisResult): AnalysisResult {
  const primary = result.tags.scene[0];
  const claimed = new Set<string>();
  if (primary) claimed.add(primary.trim().toLocaleLowerCase("zh-CN"));
  if (result.kind === "video") {
    const person = appendUnique(result.tags.person, claimed);
    const form = appendUnique(result.tags.form, claimed);
    const scene = [
      ...(primary ? [primary] : []),
      ...appendUnique(result.tags.scene.slice(1), claimed),
    ];
    return { ...result, tags: { scene, person, form } };
  }
  const person = appendUnique(result.tags.person, claimed);
  const object = appendUnique(result.tags.object, claimed);
  const style = appendUnique(result.tags.style, claimed);
  const color_composition = appendUnique(
    result.tags.color_composition,
    claimed,
  );
  const scene = [
    ...(primary ? [primary] : []),
    ...appendUnique(result.tags.scene.slice(1), claimed),
  ];
  return {
    ...result,
    tags: { scene, object, person, style, color_composition },
  };
}

function parseAnalysisText(text: string, durationSeconds: number | null) {
  const parsed = analysisResultSchema.parse(
    normalizeAnalysisPayload(
      JSON.parse(stripCodeFence(text)),
      durationSeconds,
    ),
  );
  return requireFrameSupportedClaims(
    requireChineseText(
      deduplicateTagCategories(requirePrimaryTag(parsed)),
    ),
  );
}

function extractChatText(payload: unknown) {
  const candidate = payload as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = candidate.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("");
  throw new AppError("model_response_invalid");
}

function extractResponsesText(payload: unknown) {
  const candidate = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof candidate.output_text === "string") return candidate.output_text;
  const text = candidate.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
    .join("");
  if (text) return text;
  throw new AppError("model_response_invalid");
}

async function mediaContent(
  input: AnalyzeInput,
  config: AppConfig,
  model: ModelTarget,
) {
  if (input.mediaType === "image") {
    const bytes = await fs.readFile(
      resolveMediaPath(input.relativePath, config.mediaRoot),
    );
    return {
      durationSeconds: null,
      chat: [
        {
          type: "image_url",
          image_url: {
            url: `data:${input.mimeType};base64,${bytes.toString("base64")}`,
          },
        },
      ],
      responses: [
        {
          type: "input_image",
          image_url: `data:${input.mimeType};base64,${bytes.toString("base64")}`,
        },
      ],
    };
  }
  if (
    model.protocol !== "openai_chat_completions" ||
    config.VLM_VIDEO_MODE !== "frames"
  ) {
    throw new AppError("model_video_unsupported");
  }
  const frameSet = readVideoFrameSet(input.relativePath, config.mediaRoot);
  const chat: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  for (const [index, frame] of frameSet.frames.entries()) {
    const bytes = await fs.readFile(frame.absolutePath);
    chat.push(
      {
        type: "text",
        text: `关键帧 ${index + 1}，时间点 ${frame.timestampSeconds} 秒：`,
      },
      {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        },
      },
    );
  }
  return {
    durationSeconds: frameSet.durationSeconds,
    chat,
    responses: null,
  };
}

export class OpenAICompatibleAnalyzer implements MultimodalAnalyzer {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cooldowns: ModelCandidateCooldowns;
  private readonly requestLimiter: ModelTargetRequestLimiter;

  constructor(
    private readonly config = loadConfig(),
    runtime: AnalyzerRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
    this.sleep =
      runtime.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.cooldowns = new ModelCandidateCooldowns(this.now);
    this.requestLimiter = new ModelTargetRequestLimiter(
      this.config.VLM_MAX_CONCURRENCY_PER_TARGET,
    );
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisOutcome> {
    const analysisStartedAt = this.now();
    const configuredCandidates = this.config.models.vlmCandidates;
    if (configuredCandidates.length === 0) {
      throw new AppError("model_not_configured");
    }
    const media = await mediaContent(
      input,
      this.config,
      configuredCandidates[0],
    );
    const candidates = this.cooldowns.candidatesForAttempt(configuredCandidates);
    const totalDeadlineAt =
      analysisStartedAt + this.config.VLM_TOTAL_BUDGET_MS;
    const primaryDeadlineAt = Math.min(
      totalDeadlineAt,
      analysisStartedAt + this.config.VLM_PRIMARY_BUDGET_MS,
    );
    const primary = configuredCandidates[0];
    let lastFailure: "request" | "response" = "request";

    for (const candidate of candidates) {
      const candidateDeadlineAt =
        candidate === primary ? primaryDeadlineAt : totalDeadlineAt;
      if (this.now() >= candidateDeadlineAt) continue;
      try {
        const result = await this.analyzeWithModel(
          candidate,
          input,
          media,
          candidateDeadlineAt,
        );
        this.cooldowns.clear(candidate);
        return {
          result,
          model: { protocol: candidate.protocol, name: candidate.name },
        };
      } catch (error) {
        if (error instanceof ModelRequestError) {
          if (error.kind === "fatal") {
            throw new AppError("model_request_failed");
          }
          lastFailure = "request";
          this.cooldowns.mark(
            candidate,
            this.cooldownDuration(error.kind),
            error.kind,
          );
          continue;
        }
        if (error instanceof AppError && error.code === "model_response_invalid") {
          lastFailure = "response";
          this.cooldowns.mark(
            candidate,
            this.transientCooldownDuration(),
            "response_invalid",
          );
          continue;
        }
        throw error;
      }
    }

    throw new AppError(
      lastFailure === "response"
        ? "model_response_invalid"
        : "model_request_failed",
    );
  }

  private async analyzeWithModel(
    model: ConfiguredModelTarget,
    input: AnalyzeInput,
    media: Awaited<ReturnType<typeof mediaContent>>,
    deadlineAt: number,
  ) {
    let correction: string | undefined;
    let correctionUsed = false;
    let invalidText: string | undefined;
    let retriesRemaining = this.config.VLM_RETRY_COUNT;

    while (true) {
      const attemptStartedAt = this.now();
      try {
        const text = correctionUsed
          ? await this.requestTextRepair(
              model,
              input.mediaType,
              invalidText ?? "",
              correction ?? "JSON 格式错误",
              media.durationSeconds,
              deadlineAt,
            )
          : await this.requestModel(model, input, media, deadlineAt);
        try {
          return parseAnalysisText(text, media.durationSeconds);
        } catch (error) {
          if (correctionUsed) throw new AppError("model_response_invalid");
          correctionUsed = true;
          invalidText = text;
          correction =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "JSON 格式错误";
          continue;
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "model_response_invalid"
        ) {
          if (correctionUsed) throw error;
          correctionUsed = true;
          correction = error.message.slice(0, 500);
          continue;
        }
        const requestError = this.normalizeRequestError(error);
        if (!requestError) throw error;
        const attemptDurationMs = this.now() - attemptStartedAt;
        if (
          requestError.kind !== "transient" ||
          !requestError.sameCandidateRetryable ||
          retriesRemaining === 0 ||
          attemptDurationMs > this.config.VLM_FAST_RETRY_WINDOW_MS ||
          this.now() >= deadlineAt
        ) {
          throw requestError;
        }
        retriesRemaining -= 1;
        const retryDelay = Math.min(
          requestError.retryAfterMs ?? 0,
          this.config.VLM_FAST_RETRY_WINDOW_MS,
        );
        if (this.now() + retryDelay >= deadlineAt) throw requestError;
        if (retryDelay > 0) await this.sleep(retryDelay);
      }
    }
  }

  private async requestModel(
    model: ConfiguredModelTarget,
    input: AnalyzeInput,
    media: Awaited<ReturnType<typeof mediaContent>>,
    deadlineAt: number,
  ) {
    const prompt = promptFor(input.mediaType, media.durationSeconds);
    const isChat = model.protocol === "openai_chat_completions";
    const thinking =
      model.requestOptions.enableThinking === null
        ? {}
        : { enable_thinking: model.requestOptions.enableThinking };
    const body = isChat
      ? {
          model: model.name,
          temperature: 0,
          max_tokens: this.config.VLM_MAX_OUTPUT_TOKENS,
          ...thinking,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }, ...media.chat],
            },
          ],
        }
      : {
          model: model.name,
          max_output_tokens: this.config.VLM_MAX_OUTPUT_TOKENS,
          ...thinking,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                ...(media.responses ?? []),
              ],
            },
          ],
        };
    return this.executeModelRequest(model, input.mediaType, body, deadlineAt);
  }

  private requestTextRepair(
    model: ConfiguredModelTarget,
    mediaType: MediaType,
    invalidText: string,
    correction: string,
    durationSeconds: number | null,
    deadlineAt: number,
  ) {
    const prompt = repairPromptFor(
      mediaType,
      invalidText,
      correction,
      durationSeconds,
    );
    const isChat = model.protocol === "openai_chat_completions";
    const thinking =
      model.requestOptions.enableThinking === null
        ? {}
        : { enable_thinking: model.requestOptions.enableThinking };
    const body = isChat
      ? {
          model: model.name,
          temperature: 0,
          max_tokens: this.config.VLM_MAX_OUTPUT_TOKENS,
          ...thinking,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
        }
      : {
          model: model.name,
          max_output_tokens: this.config.VLM_MAX_OUTPUT_TOKENS,
          ...thinking,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          ],
        };
    return this.executeModelRequest(model, mediaType, body, deadlineAt);
  }

  private executeModelRequest(
    model: ConfiguredModelTarget,
    mediaType: MediaType,
    body: unknown,
    deadlineAt: number,
  ) {
    return this.requestLimiter.run(model, async () => {
      const remainingBudgetMs = deadlineAt - this.now();
      if (remainingBudgetMs <= 0) throw new ModelDeadlineExceededError();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(
          remainingBudgetMs,
          mediaType === "video"
            ? this.config.VLM_VIDEO_TIMEOUT_MS
            : this.config.VLM_TIMEOUT_MS,
        ),
      );
      const isChat = model.protocol === "openai_chat_completions";
      const endpoint = isChat ? "chat/completions" : "responses";

      try {
        const response = await fetch(`${model.baseUrl}/${endpoint}`, {
          method: "POST",
          headers: {
            ...(model.apiKey
              ? { authorization: `Bearer ${model.apiKey}` }
              : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await modelRequestErrorFromResponse(response, this.now());
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          if (
            error instanceof TypeError ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            throw error;
          }
          throw new AppError("model_response_invalid");
        }
        return isChat ? extractChatText(payload) : extractResponsesText(payload);
      } finally {
        clearTimeout(timer);
      }
    }, deadlineAt, this.now);
  }

  private normalizeRequestError(error: unknown) {
    if (error instanceof ModelRequestError) return error;
    if (error instanceof Error && error.name === "AbortError") {
      return new ModelRequestError({
        kind: "transient",
        sameCandidateRetryable: false,
        message: "Model request timed out.",
      });
    }
    if (error instanceof ModelDeadlineExceededError) {
      return new ModelRequestError({
        kind: "transient",
        sameCandidateRetryable: false,
        message: error.message,
      });
    }
    if (error instanceof TypeError) {
      return new ModelRequestError({
        kind: "transient",
        message: "Model network request failed.",
      });
    }
    return undefined;
  }

  private cooldownDuration(kind: ModelRequestError["kind"]) {
    return kind === "quota" || kind === "candidate"
      ? this.config.VLM_FAILOVER_COOLDOWN_MS
      : this.transientCooldownDuration();
  }

  private transientCooldownDuration() {
    return Math.min(this.config.VLM_FAILOVER_COOLDOWN_MS, 60_000);
  }
}
