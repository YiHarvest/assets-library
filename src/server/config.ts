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
const objectPrefixSchema = z
  .string()
  .trim()
  .default("")
  .transform((value) => value.replace(/^\/+|\/+$/g, ""))
  .refine(
    (value) =>
      !value ||
      (!value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((part) => part && part !== "." && part !== "..")),
    "对象存储前缀必须是安全的相对路径。",
  );
const MODEL_FAMILY_THINKING_DEFAULTS = [
  { namePattern: /^qwen3\.[5-9]/i, enableThinking: false },
] as const;
const MAX_MODEL_CANDIDATES_PER_ROLE = 5;

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
    DATABASE_URL: z
      .string()
      .url()
      .default("mysql://assets_library_app:change-me@127.0.0.1:3306/assets_library"),
    DATABASE_SSL_CA_PATH: z.string().optional().or(z.literal("")),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    UPLOAD_MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024 * 1024),
    PENDING_ASSET_RETENTION_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(24),
    TASK_HISTORY_RETENTION_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(24),
    CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3_600),
    MEDIA_ROOT: z.string().default("./media"),
    MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
    MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
    SCENE_DETECT_ENABLED: booleanSchema.default(true),
    SCENE_DETECT_BASE_URL: z.string().url().default("http://127.0.0.1:28200"),
    SCENE_DETECT_PROJECT_DIR: z.string().default("../scene-detect-service"),
    SCENE_DETECT_WORKSPACE_ROOT: z.string().default("./media/.scene-service"),
    SCENE_DETECT_PORT: z.coerce.number().int().min(1).max(65_535).default(28_200),
    SCENE_DETECT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    SCENE_DETECT_TASK_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    SCENE_SEGMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    ZOS_ACCESS_KEY_ID: z.string().optional(),
    ZOS_SECRET_ACCESS_KEY: z.string().optional(),
    ZOS_API_ENDPOINT: z.string().url().optional().or(z.literal("")),
    ZOS_ENDPOINT: z.string().url().optional().or(z.literal("")),
    ZOS_BUCKET: z.string().optional(),
    /** 所有由本服务长期写入的 ZOS key 都自动位于此前缀下。 */
    ZOS_OBJECT_PREFIX: objectPrefixSchema,
    ZOS_WEB_URL: z.string().url().optional().or(z.literal("")),
    ZOS_INTERNAL_URL: z.string().url().optional().or(z.literal("")),
    ZOS_FORCE_PATH_STYLE: booleanSchema.default(true),
    ZOS_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    /** 外部临时文件服务；当前仅配置，待临时媒体 refactor 接入。 */
    ZOS_TEMP_UPLOAD_URL: z.string().url().optional().or(z.literal("")),
    VLM_PROTOCOL: modelProtocolSchema.default("openai_chat_completions"),
    VLM_BASE_URL: z.string().url().optional().or(z.literal("")),
    VLM_API_KEY: z.string().optional(),
    VLM_NAME: z.string().optional(),
    VLM_FALLBACK_NAMES: z.string().optional(),
    VLM_ENABLE_THINKING: optionalBooleanSchema,
    VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    VLM_VIDEO_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    VLM_RETRY_COUNT: z.coerce.number().int().min(0).max(3).default(1),
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
  const databaseSslCaPath = optionalValue(parsed.DATABASE_SSL_CA_PATH);
  const vlm = modelTarget(
    "vlm",
    parsed.VLM_PROTOCOL,
    parsed.VLM_BASE_URL,
    parsed.VLM_API_KEY,
    parsed.VLM_NAME,
    parsed.VLM_ENABLE_THINKING,
  );
  const vlmCandidates = configuredModelCandidates(
    "vlm",
    parsed.VLM_PROTOCOL,
    parsed.VLM_BASE_URL,
    parsed.VLM_API_KEY,
    parsed.VLM_NAME,
    parsed.VLM_FALLBACK_NAMES,
    parsed.VLM_ENABLE_THINKING,
  );
  const llmBaseUrl = parsed.LLM_BASE_URL || vlm.baseUrl;
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
    optionalValue(parsed.EMBEDDING_BASE_URL)?.replace(/\/$/, "") ??
    embeddingFallbackTarget?.baseUrl;
  const embeddingApiKey =
    optionalValue(parsed.EMBEDDING_API_KEY) ?? embeddingFallbackTarget?.apiKey;
  return {
    ...parsed,
    databaseUrl: parsed.DATABASE_URL,
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
