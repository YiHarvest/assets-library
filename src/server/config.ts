import path from "node:path";
import { z } from "zod";

const modelProtocolSchema = z.enum([
  "openai_chat_completions",
  "openai_responses",
]);
const optionalBooleanSchema = z
  .union([z.enum(["true", "false"]), z.literal("")])
  .optional();
const booleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");
const MODEL_FAMILY_THINKING_DEFAULTS = [
  { namePattern: /^qwen3\.[5-9]/i, enableThinking: false },
] as const;
const MAX_MODEL_CANDIDATES_PER_ROLE = 5;
const appModeSchema = z.enum(["dev", "prd"]);
const internalServiceHostSchema = z
  .string()
  .trim()
  .min(1)
  .refine((host) => host !== "0.0.0.0" && host !== "::", {
    message: "客户端连接地址不能使用通配监听地址。",
  });

export type ModelProtocol = z.infer<typeof modelProtocolSchema>;
export type ModelRole = "vlm" | "llm";

interface ModelTargetBase {
  role: ModelRole;
  protocol: ModelProtocol;
  apiKey?: string;
  requestOptions: {
    enableThinking: boolean | null;
  };
}

export type ModelTarget = ModelTargetBase &
  (
    | { configured: true; baseUrl: string; name: string }
    | { configured: false; baseUrl?: string; name?: string }
  );
export type ConfiguredModelTarget = Extract<
  ModelTarget,
  { configured: true }
>;

function candidateNames(
  primaryName: string | undefined,
  fallbackNames: string | undefined,
) {
  const names = [primaryName, ...(fallbackNames?.split(",") ?? [])]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

const envSchema = z
  .object({
    APP_MODE: appModeSchema.default("dev"),
    PRD_INTERNAL_SERVICE_HOST: internalServiceHostSchema.default("127.0.0.1"),
    DATABASE_URL: z
      .string()
      .url()
      .default("mysql://assets_library_app:change-me@127.0.0.1:3306/assets_library"),
    DEV_DATABASE_NAME: z
      .string()
      .min(1)
      .refine((name) => name.endsWith("_test"), {
        message: "开发模式数据库名必须以 _test 结尾。",
      })
      .default("assets_library_dev_test"),
    DATABASE_SSL_CA_PATH: z.string().optional().or(z.literal("")),
    // Web 与 worker 是独立进程，各自持有连接池；默认 6 为 4 个 worker 留出余量。
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(6),
    UPLOAD_MAX_ITEMS: z.coerce.number().int().min(1).max(100).default(100),
    UPLOAD_MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024 * 1024),
    STAGING_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
    TASK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3_600),
    MEDIA_ROOT: z.string().default("./media"),
    // auto 优先尝试 NVIDIA 硬解/硬编码并在不可用时回退 CPU。
    FFMPEG_HW_ACCEL: z.enum(["auto", "cuda", "none"]).default("auto"),
    // 主应用数据库作业 worker 数；领取使用 SKIP LOCKED，可在同一进程并发运行。
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    // 多任务竞争时，同一任务最多占用的素材分析 worker 数；无竞争时可突发至全局上限。
    WORKER_ANALYZE_TASK_SOFT_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(2),
    MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
    MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
    SCENE_DETECT_ENABLED: booleanSchema.default(true),
    SCENE_DETECT_BASE_URL: z.string().url().default("http://127.0.0.1:28200"),
    SCENE_DETECT_PROJECT_DIR: z.string().default("../scene-detect-service"),
    SCENE_DETECT_WORKSPACE_ROOT: z.string().default("./media/.scene-service"),
    SCENE_DETECT_PORT: z.coerce.number().int().min(1).max(65_535).default(28_200),
    // 异步队列模式下 POST 立即返回，客户端轮询状态直到完成。
    // 总预算需覆盖排队时间（并发 worker 数固定，高峰任务会排队），默认 10 分钟。
    SCENE_DETECT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    // 状态轮询间隔
    SCENE_DETECT_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1_000),
    // 分片下载/验证/抽帧的并发上限（父视频切出的分片逐个流水线处理，并发吃满多核）
    SCENE_SEGMENT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    // 父视频、分片和缩略图上传 ZOS 的并发上限。
    SCENE_PERSIST_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    SCENE_DETECT_TASK_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    SCENE_SEGMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    ZOS_ACCESS_KEY_ID: z.string().optional(),
    ZOS_SECRET_ACCESS_KEY: z.string().optional(),
    ZOS_API_ENDPOINT: z.string().url().optional().or(z.literal("")),
    ZOS_ENDPOINT: z.string().url().optional().or(z.literal("")),
    ZOS_BUCKET: z.string().optional(),
    ZOS_WEB_URL: z.string().url().optional().or(z.literal("")),
    ZOS_INTERNAL_URL: z.string().url().optional().or(z.literal("")),
    ZOS_FORCE_PATH_STYLE: booleanSchema.default(true),
    ZOS_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    VLM_PROTOCOL: modelProtocolSchema.default("openai_chat_completions"),
    VLM_BASE_URL: z.string().url().optional().or(z.literal("")),
    VLM_API_KEY: z.string().optional(),
    VLM_NAME: z.string().optional(),
    VLM_FALLBACK_NAMES: z.string().optional(),
    VLM_ENABLE_THINKING: optionalBooleanSchema,
    VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    VLM_VIDEO_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // 单次生成上限；视频结构化结果通常低于 1k tokens，保留少量安全余量。
    VLM_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(128)
      .max(32_768)
      .default(1_280),
    // 从素材开始分析起计算，包含目标并发排队、请求、文本修复和 fallback。
    VLM_PRIMARY_BUDGET_MS: z.coerce.number().int().positive().default(60_000),
    VLM_TOTAL_BUDGET_MS: z.coerce.number().int().positive().default(90_000),
    // 只有在此窗口内快速失败的网络错误/5xx/429 才允许重试当前候选。
    VLM_FAST_RETRY_WINDOW_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(5_000),
    VLM_RETRY_COUNT: z.coerce.number().int().min(0).max(3).default(1),
    // 同一 VLM 模型目标的进程内请求并发，避免单个模型被全局 worker 突发压满。
    VLM_MAX_CONCURRENCY_PER_TARGET: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(2),
    VLM_FAILOVER_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(1_800_000),
    VLM_VIDEO_MODE: z.enum(["disabled", "frames"]).default("frames"),
    LLM_PROTOCOL: modelProtocolSchema.default("openai_chat_completions"),
    LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
    LLM_API_KEY: z.string().optional(),
    LLM_NAME: z.string().optional(),
    LLM_FALLBACK_NAMES: z.string().optional(),
    LLM_ENABLE_THINKING: optionalBooleanSchema,
    CHROMA_URL: z.string().url().default("http://127.0.0.1:8000"),
    CHROMA_COLLECTION: z.string().min(3).default("asset_analysis"),
    CHROMA_TENANT: z.string().default("default_tenant"),
    CHROMA_DATABASE: z.string().default("default_database"),
    EMBEDDING_BASE_URL: z.string().url().optional().or(z.literal("")),
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.WORKER_ANALYZE_TASK_SOFT_LIMIT > env.WORKER_CONCURRENCY) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_ANALYZE_TASK_SOFT_LIMIT"],
        message: "单任务分析软上限不能超过全局 worker 并发数。",
      });
    }
    if (env.VLM_PRIMARY_BUDGET_MS > env.VLM_TOTAL_BUDGET_MS) {
      context.addIssue({
        code: "custom",
        path: ["VLM_PRIMARY_BUDGET_MS"],
        message: "VLM 主模型预算不能超过全候选链路总预算。",
      });
    }
    for (const role of ["VLM", "LLM"] as const) {
      const primaryName = env[`${role}_NAME`];
      const fallbackNames = env[`${role}_FALLBACK_NAMES`];
      const candidates = candidateNames(primaryName, fallbackNames);
      if (fallbackNames?.trim() && !primaryName?.trim()) {
        context.addIssue({
          code: "custom",
          path: [`${role}_FALLBACK_NAMES`],
          message: `${role}_NAME is required when fallbacks are configured.`,
        });
      }
      if (candidates.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
        context.addIssue({
          code: "custom",
          path: [`${role}_FALLBACK_NAMES`],
          message: `${role} supports at most ${MAX_MODEL_CANDIDATES_PER_ROLE} model candidates.`,
        });
      }
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

function optionalValue(value: string | undefined) {
  return value?.trim() || undefined;
}

function internalServiceUrl(
  value: string | undefined,
  appMode: z.infer<typeof appModeSchema>,
  productionHost: string,
) {
  const normalizedValue = optionalValue(value);
  if (!normalizedValue) return undefined;
  const url = new URL(normalizedValue);
  if (appMode === "prd") url.hostname = productionHost;
  return url.toString().replace(/\/$/, "");
}

export function databaseTarget(url: string) {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname,
    port: parsed.port || "3306",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

export function assertDatabaseTargetSafety(
  appMode: z.infer<typeof appModeSchema>,
  url: string,
) {
  const target = databaseTarget(url);
  if (appMode === "dev" && !target.database.endsWith("_test")) {
    throw new Error(
      `开发模式拒绝连接非测试数据库：${target.hostname}:${target.port}/${target.database}`,
    );
  }
  if (appMode === "prd" && target.database.endsWith("_test")) {
    throw new Error(
      `生产模式拒绝连接测试数据库：${target.hostname}:${target.port}/${target.database}`,
    );
  }
  return target;
}

function defaultThinkingOption(modelName: string | undefined) {
  return (
    MODEL_FAMILY_THINKING_DEFAULTS.find(({ namePattern }) =>
      namePattern.test(modelName ?? ""),
    )?.enableThinking ?? null
  );
}

function thinkingOption(
  value: string | undefined,
  modelName: string | undefined,
) {
  const normalizedValue = optionalValue(value);
  if (normalizedValue !== undefined) return normalizedValue === "true";
  return defaultThinkingOption(modelName);
}

function firstConfiguredModelTarget(
  targets: readonly ModelTarget[],
): ConfiguredModelTarget | undefined {
  return targets.find(
    (target): target is ConfiguredModelTarget => target.configured,
  );
}

function modelTarget(
  role: ModelRole,
  protocol: ModelProtocol,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  name: string | undefined,
  enableThinking: string | undefined,
): ModelTarget {
  const normalizedBaseUrl = optionalValue(baseUrl)?.replace(/\/$/, "");
  const normalizedApiKey = optionalValue(apiKey);
  const normalizedName = optionalValue(name);
  const target = {
    role,
    protocol,
    apiKey: normalizedApiKey,
    requestOptions: {
      enableThinking: thinkingOption(enableThinking, normalizedName),
    },
  };
  if (normalizedBaseUrl && normalizedName) {
    return {
      ...target,
      configured: true,
      baseUrl: normalizedBaseUrl,
      name: normalizedName,
    };
  }
  return {
    ...target,
    configured: false,
    baseUrl: normalizedBaseUrl,
    name: normalizedName,
  };
}

function configuredModelCandidates(
  role: ModelRole,
  protocol: ModelProtocol,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  primaryName: string | undefined,
  fallbackNames: string | undefined,
  enableThinking: string | undefined,
) {
  return candidateNames(primaryName, fallbackNames)
    .map((name) =>
      modelTarget(role, protocol, baseUrl, apiKey, name, enableThinking),
    )
    .filter((target): target is ConfiguredModelTarget => target.configured);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = envSchema.parse(env);
  const databaseUrl = new URL(parsed.DATABASE_URL);
  if (parsed.APP_MODE === "dev") {
    databaseUrl.pathname = `/${encodeURIComponent(parsed.DEV_DATABASE_NAME)}`;
  } else {
    databaseUrl.hostname = parsed.PRD_INTERNAL_SERVICE_HOST;
  }
  const resolvedDatabaseUrl = databaseUrl.toString();
  const resolvedDatabaseTarget = assertDatabaseTargetSafety(
    parsed.APP_MODE,
    resolvedDatabaseUrl,
  );
  const vlmBaseUrl = internalServiceUrl(
    parsed.VLM_BASE_URL,
    parsed.APP_MODE,
    parsed.PRD_INTERNAL_SERVICE_HOST,
  );
  const configuredLlmBaseUrl = internalServiceUrl(
    parsed.LLM_BASE_URL,
    parsed.APP_MODE,
    parsed.PRD_INTERNAL_SERVICE_HOST,
  );
  const databaseSslCaPath = optionalValue(parsed.DATABASE_SSL_CA_PATH);
  const vlm = modelTarget(
    "vlm",
    parsed.VLM_PROTOCOL,
    vlmBaseUrl,
    parsed.VLM_API_KEY,
    parsed.VLM_NAME,
    parsed.VLM_ENABLE_THINKING,
  );
  const vlmCandidates = configuredModelCandidates(
    "vlm",
    parsed.VLM_PROTOCOL,
    vlmBaseUrl,
    parsed.VLM_API_KEY,
    parsed.VLM_NAME,
    parsed.VLM_FALLBACK_NAMES,
    parsed.VLM_ENABLE_THINKING,
  );
  const llmBaseUrl = configuredLlmBaseUrl || vlm.baseUrl;
  const llmApiKey = optionalValue(parsed.LLM_API_KEY) ?? vlm.apiKey;
  const llm = modelTarget(
    "llm",
    parsed.LLM_PROTOCOL,
    llmBaseUrl,
    llmApiKey,
    parsed.LLM_NAME,
    parsed.LLM_ENABLE_THINKING,
  );
  const llmCandidates = configuredModelCandidates(
    "llm",
    parsed.LLM_PROTOCOL,
    llmBaseUrl,
    llmApiKey,
    parsed.LLM_NAME,
    parsed.LLM_FALLBACK_NAMES,
    parsed.LLM_ENABLE_THINKING,
  );
  const embeddingFallbackTarget = firstConfiguredModelTarget([
    ...vlmCandidates,
    ...llmCandidates,
  ]);
  const embeddingBaseUrl =
    internalServiceUrl(
      parsed.EMBEDDING_BASE_URL,
      parsed.APP_MODE,
      parsed.PRD_INTERNAL_SERVICE_HOST,
    ) ??
    embeddingFallbackTarget?.baseUrl;
  const embeddingApiKey =
    optionalValue(parsed.EMBEDDING_API_KEY) ?? embeddingFallbackTarget?.apiKey;
  return {
    ...parsed,
    databaseUrl: resolvedDatabaseUrl,
    databaseTarget: resolvedDatabaseTarget,
    databaseSslCaPath: databaseSslCaPath
      ? path.resolve(databaseSslCaPath)
      : undefined,
    mediaRoot: path.resolve(parsed.MEDIA_ROOT),
    sceneDetectProjectDir: path.resolve(parsed.SCENE_DETECT_PROJECT_DIR),
    sceneDetectWorkspaceRoot: path.resolve(parsed.SCENE_DETECT_WORKSPACE_ROOT),
    zosConfigured: Boolean(
      optionalValue(parsed.ZOS_ACCESS_KEY_ID) &&
      optionalValue(parsed.ZOS_SECRET_ACCESS_KEY) &&
      (optionalValue(parsed.ZOS_API_ENDPOINT) ||
          optionalValue(parsed.ZOS_ENDPOINT) ||
          optionalValue(parsed.ZOS_INTERNAL_URL)) &&
      optionalValue(parsed.ZOS_BUCKET),
    ),
    models: { vlm, llm, vlmCandidates, llmCandidates },
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingConfigured: Boolean(embeddingBaseUrl && parsed.EMBEDDING_MODEL),
  };
}
