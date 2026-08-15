import type { ConfiguredModelTarget } from "@/server/config";

export type ModelFailureKind =
  | "fatal"
  | "quota"
  | "transient"
  | "candidate";

interface ModelRequestErrorOptions {
  kind: ModelFailureKind;
  status?: number;
  gatewayCode?: string;
  gatewayType?: string;
  retryAfterMs?: number;
  /** false 表示继续等待同一候选没有收益，应立即尝试下一个 fallback。 */
  sameCandidateRetryable?: boolean;
  message?: string;
}

export class ModelRequestError extends Error {
  readonly kind: ModelFailureKind;
  readonly status?: number;
  readonly gatewayCode?: string;
  readonly gatewayType?: string;
  readonly retryAfterMs?: number;
  readonly sameCandidateRetryable: boolean;

  constructor(options: ModelRequestErrorOptions) {
    super(options.message ?? "Model request failed.");
    this.name = "ModelRequestError";
    this.kind = options.kind;
    this.status = options.status;
    this.gatewayCode = options.gatewayCode;
    this.gatewayType = options.gatewayType;
    this.retryAfterMs = options.retryAfterMs;
    this.sameCandidateRetryable = options.sameCandidateRetryable ?? true;
  }
}

function sanitizedText(value: unknown, limit = 300) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, limit)
    : undefined;
}

function retryAfterMs(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

function failureKindFromStatus(status: number): ModelFailureKind {
  if (status === 401 || status === 403) return "fatal";
  if (status === 402) return "quota";
  if (status === 404) return "candidate";
  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  ) {
    return "transient";
  }
  return "fatal";
}

const quotaPattern =
  /insufficient[_ -]?quota|quota[_ -]?exceeded|billing|credit|余额不足|额度不足|配额不足/i;
const missingModelPattern =
  /model[_ -]?not[_ -]?found|unknown model|模型.{0,20}不存在/i;
const unsupportedVisionPattern =
  /(?:unsupported|does not support|not supported).{0,40}(?:image|vision)|(?:image(?:_url| input)?|vision).{0,40}(?:unsupported|does not support|not supported)|不支持.{0,20}(?:图片|图像|视觉)|(?:图片|图像|视觉).{0,20}(?:不支持|不受支持)/i;

export async function modelRequestErrorFromResponse(
  response: Response,
  now: number,
) {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return new ModelRequestError({
        kind: failureKindFromStatus(response.status),
        status: response.status,
        sameCandidateRetryable: response.status !== 408,
        message: "Model error response body could not be read.",
      });
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = undefined;
  }
  const gatewayError = (payload as {
    error?: { code?: unknown; type?: unknown; message?: unknown };
  } | undefined)?.error;
  const gatewayCode = sanitizedText(gatewayError?.code);
  const gatewayType = sanitizedText(gatewayError?.type);
  const message =
    sanitizedText(gatewayError?.message) ??
    sanitizedText(rawBody) ??
    `HTTP ${response.status}`;
  const classificationText = [gatewayCode, gatewayType, message]
    .filter(Boolean)
    .join(" ");

  let kind: ModelFailureKind;
  if (response.status === 401 || response.status === 403) {
    kind = "fatal";
  } else if (response.status === 402 || quotaPattern.test(classificationText)) {
    kind = "quota";
  } else if (
    missingModelPattern.test(classificationText) ||
    unsupportedVisionPattern.test(classificationText) ||
    response.status === 404
  ) {
    kind = "candidate";
  } else {
    kind = failureKindFromStatus(response.status);
  }

  return new ModelRequestError({
    kind,
    status: response.status,
    gatewayCode,
    gatewayType,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now),
    sameCandidateRetryable: response.status !== 408,
    message,
  });
}

interface CooldownEntry {
  until: number;
  reason: Exclude<ModelFailureKind, "fatal"> | "response_invalid";
}

export class ModelCandidateCooldowns {
  private readonly entries = new Map<string, CooldownEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  candidatesForAttempt(candidates: readonly ConfiguredModelTarget[]) {
    const now = this.now();
    const active = candidates.filter((candidate) => {
      const entry = this.entries.get(this.key(candidate));
      if (!entry || entry.until <= now) {
        this.entries.delete(this.key(candidate));
        return true;
      }
      return false;
    });
    if (active.length > 0) return active;

    const earliest = candidates
      .map((candidate) => ({ candidate, entry: this.entries.get(this.key(candidate)) }))
      .filter(
        (item): item is { candidate: ConfiguredModelTarget; entry: CooldownEntry } =>
          Boolean(item.entry),
      )
      .sort((left, right) => left.entry.until - right.entry.until)[0];
    return earliest ? [earliest.candidate] : [];
  }

  mark(
    candidate: ConfiguredModelTarget,
    durationMs: number,
    reason: CooldownEntry["reason"],
  ) {
    if (durationMs <= 0) return;
    this.entries.set(this.key(candidate), {
      until: this.now() + durationMs,
      reason,
    });
  }

  clear(candidate: ConfiguredModelTarget) {
    this.entries.delete(this.key(candidate));
  }

  private key(candidate: ConfiguredModelTarget) {
    return `${candidate.baseUrl}\0${candidate.name}`;
  }
}
