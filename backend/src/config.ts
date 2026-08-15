import { z } from "zod";

const booleanValue = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const DEFAULT_SCENE_SEGMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_SCENE_HEALTH_TIMEOUT_MS = 8_000;
export const UPLOAD_URL_TTL_SECONDS = 24 * 60 * 60;

const envSchema = z.object({
  BACKEND_HOST: z.string().default("127.0.0.1"),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(23017),
  DATABASE_URL: z.url(),
  DATABASE_SSL_CA_PATH: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  ZOS_API_ENDPOINT: z.url(),
  ZOS_BUCKET: z.string().trim().min(1),
  ZOS_ACCESS_KEY_ID: z.string().trim().min(1),
  ZOS_SECRET_ACCESS_KEY: z.string().trim().min(1),
  ZOS_WEB_URL: z.url(),
  ZOS_REGION: z.string().trim().min(1).default("hangzhou-7"),
  ZOS_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ZOS_TMP_PREFIX: z.string().trim().min(1).default("tmp/test_assets"),
  ZOS_PERMANENT_PREFIX: z.string().trim().min(1).default("test_assets"),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().refine(
    (value) => value === UPLOAD_URL_TTL_SECONDS,
    "UPLOAD_URL_TTL_SECONDS 必须固定为86400秒。",
  ).default(UPLOAD_URL_TTL_SECONDS),
  TEMP_FILE_TTL_HOURS: z.coerce.number().positive().default(24),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  WORKER_INSTANCES: z.coerce.number().int().min(1).max(16).default(1),
  WORKER_INDEX: z.coerce.number().int().min(1).max(16).default(1),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_STALE_SECONDS: z.coerce.number().int().min(30).default(300),
  WORKER_MAINTENANCE_SECONDS: z.coerce.number().int().min(10).default(60),
  WORKER_SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(30),
  TASK_HISTORY_RETENTION_HOURS: z.coerce.number().positive().default(24),
  CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  CALLBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  CALLBACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  RUNTIME_DIR: z.string().optional(),
  SLOW_OPERATION_MS: z.coerce.number().int().positive().default(1000),
  OBSERVABILITY_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(3000),
  TEMP_UPLOAD_IP_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  TEMP_UPLOAD_USER_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  TEMP_UPLOAD_BATCH_MAX_BYTES: z.coerce.number().int().positive().max(200 * 1024 * 1024).default(200 * 1024 * 1024),
  TEMP_UPLOAD_DISK_QUOTA_BYTES: z.coerce.number().int().min(200 * 1024 * 1024).default(1024 * 1024 * 1024),
  TEMP_UPLOAD_MAX_ACTIVE_FILES: z.coerce.number().int().min(1).max(1024).default(32),
  TEMP_UPLOAD_AUDIT_SALT: z.string().min(32),
  CHROMA_URL: z.url().default("http://127.0.0.1:23016"),
  CHROMA_COLLECTION: z.string().min(3).default("asset_analysis"),
  CHROMA_TENANT: z.string().default("default_tenant"),
  CHROMA_DATABASE: z.string().default("default_database"),
  EMBEDDING_BASE_URL: z.string().url().optional().or(z.literal("")),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  SCENE_DETECT_BASE_URL: z.url().default("http://127.0.0.1:28200"),
  SCENE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(DEFAULT_SCENE_HEALTH_TIMEOUT_MS),
  // 异步分镜的总预算包含上传、排队和执行时间。
  SCENE_DETECT_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  SCENE_DETECT_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(10000).default(1000),
  SCENE_SEGMENT_MAX_BYTES: z.coerce.number().int().positive().default(DEFAULT_SCENE_SEGMENT_MAX_BYTES),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  VLM_PROTOCOL: z.enum(["openai_chat_completions", "openai_responses"]).default("openai_chat_completions"),
  VLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  VLM_API_KEY: z.string().optional(),
  VLM_NAME: z.string().optional(),
  VLM_FALLBACK_NAMES: z.string().optional(),
  VLM_ENABLE_THINKING: booleanValue,
  VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  VLM_VIDEO_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  VLM_RETRY_COUNT: z.coerce.number().int().min(0).max(3).default(1),
  VLM_FAILOVER_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(1800000),
}).superRefine((value, context) => {
  const temporary = value.ZOS_TMP_PREFIX.replace(/^\/+|\/+$/g, "");
  const permanent = value.ZOS_PERMANENT_PREFIX.replace(/^\/+|\/+$/g, "");
  if (temporary === permanent || temporary.startsWith(`${permanent}/`) || permanent.startsWith(`${temporary}/`)) {
    context.addIssue({
      code: "custom",
      path: ["ZOS_TMP_PREFIX"],
      message: "ZOS_TMP_PREFIX 与 ZOS_PERMANENT_PREFIX 必须不同且不能互为父前缀。",
    });
  }
  const vlmNames = [value.VLM_NAME, ...(value.VLM_FALLBACK_NAMES?.split(",") ?? [])]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  if (new Set(vlmNames).size > 5) {
    context.addIssue({
      code: "custom",
      path: ["VLM_FALLBACK_NAMES"],
      message: "VLM 主模型与去重后的备用模型总数不能超过 5 个。",
    });
  }
  if (value.WORKER_INDEX > value.WORKER_INSTANCES) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_INDEX"],
      message: "WORKER_INDEX 不能大于 WORKER_INSTANCES。",
    });
  }
});

export type BackendConfig = z.infer<typeof envSchema>;

let cached: BackendConfig | undefined;

export function loadConfig(): BackendConfig {
  cached ??= envSchema.parse(process.env);
  return cached;
}
