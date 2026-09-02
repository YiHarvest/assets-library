import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import { loadConfig } from "@/server/config";
import { db } from "@/server/db";
import { jobs, tasks } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import {
  completeJob,
  failJob,
  getAssetRecord,
  requeueJob,
  searchAssetsByDescriptionDetailed,
  type ClaimedJob,
  type DescriptionSearchResult,
} from "@/server/repositories/assets";
import { persistedTaskError } from "@/server/services/task-lifecycle";
import {
  compatibilityMatchRequestSchema,
  type CompatibilityMatchAccepted,
  type CompatibilityMatchRequest,
} from "@/shared/contracts";

const callbackPayloadKey = "compatibilityCallback";
const maximumConcurrentMatches = 4;
const maximumMatchAttempts = 3;
const knownRequestFields = new Set([
  "asr",
  "asset_url_list",
  "callback_url",
  "llm",
  "text",
]);

interface TimedWord {
  beginTime: number;
  endTime: number;
  sentenceIndex: number;
}

export interface AlignedCompatibilitySegment extends Record<string, unknown> {
  segment_id: number;
  text: string;
  keyword: string;
  level: number;
  group_id: [number, number];
  start_time: number;
  end_time: number;
}

export interface MatchedCompatibilitySegment
  extends AlignedCompatibilitySegment {
  matched_candidate_url: string | null;
  matched_candidate_type: "image" | "video" | null;
  matched_candidate_desc: string | null;
  matched_candidate_score: number | null;
  matched_candidate_reason: DescriptionSearchResult["reason"] | null;
  matched_candidate_message: string | null;
}

const compatibilityJobPayloadSchema = z.object({
  request: compatibilityMatchRequestSchema,
  publicOrigin: z.string().url(),
  callbackFields: z.record(z.string(), z.unknown()),
});

function comparableCharacters(value: string) {
  return Array.from(value.normalize("NFKC").toLocaleLowerCase()).filter(
    (character) => /[\p{L}\p{N}]/u.test(character),
  );
}

function findSequence(
  source: readonly string[],
  target: readonly string[],
  start: number,
) {
  outer: for (let index = start; index <= source.length - target.length; index += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[index + offset] !== target[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** 将 LLM 顺序分段映射回 ASR 逐词时间，并计算每个原句内的 [序号, 总数]。 */
export function alignCompatibilitySegments(
  request: CompatibilityMatchRequest,
): AlignedCompatibilitySegment[] {
  const transcript = request.asr.transcripts[0];
  if (!transcript) {
    throw new AppError("invalid_request", "ASR transcripts 不能为空。", 400);
  }

  const sourceCharacters: string[] = [];
  const characterWords: TimedWord[] = [];
  for (const [sentenceIndex, sentence] of transcript.sentences.entries()) {
    for (const word of sentence.words) {
      for (const character of comparableCharacters(word.text)) {
        sourceCharacters.push(character);
        characterWords.push({
          beginTime: word.begin_time,
          endTime: word.end_time,
          sentenceIndex,
        });
      }
    }
  }
  if (!sourceCharacters.length) {
    throw new AppError("invalid_request", "ASR 不包含可对齐的文字。", 400);
  }

  let cursor = 0;
  const provisional = request.llm.segments.map((segment) => {
    const target = comparableCharacters(segment.text);
    if (!target.length) {
      throw new AppError(
        "invalid_request",
        `分段 ${segment.segment_id} 不包含可对齐的文字。`,
        400,
      );
    }
    const start = findSequence(sourceCharacters, target, cursor);
    if (start < 0) {
      throw new AppError(
        "invalid_request",
        `分段 ${segment.segment_id} 无法按顺序对齐 ASR：${segment.text}`,
        400,
      );
    }
    const firstWord = characterWords[start]!;
    const lastWord = characterWords[start + target.length - 1]!;
    cursor = start + target.length;
    return { segment, firstWord, lastWord };
  });

  const totals = new Map<number, number>();
  for (const item of provisional) {
    totals.set(
      item.firstWord.sentenceIndex,
      (totals.get(item.firstWord.sentenceIndex) ?? 0) + 1,
    );
  }
  const positions = new Map<number, number>();
  return provisional.map(({ segment, firstWord, lastWord }) => {
    const sentenceIndex = firstWord.sentenceIndex;
    const position = (positions.get(sentenceIndex) ?? 0) + 1;
    positions.set(sentenceIndex, position);
    const {
      high_light_word: highlightedKeyword,
      keyword: suppliedKeyword,
      ...preserved
    } = segment;
    return {
      ...preserved,
      segment_id: segment.segment_id,
      text: segment.text,
      keyword: highlightedKeyword ?? suppliedKeyword ?? "",
      level: segment.level,
      group_id: [position, totals.get(sentenceIndex) ?? 1],
      start_time: firstWord.beginTime / 1_000,
      end_time: lastWord.endTime / 1_000,
    };
  });
}

function callbackFields(request: CompatibilityMatchRequest) {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !knownRequestFields.has(key)),
  );
}

function compatibilityCompletedAt(now: Date) {
  return now.toISOString().replace("Z", "000");
}

function withUserScope(mediaUrl: string, userId: string | null) {
  if (!userId) return mediaUrl;
  const separator = mediaUrl.includes("?") ? "&" : "?";
  return `${mediaUrl}${separator}user_id=${encodeURIComponent(userId)}`;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

interface CompatibilityMatchDependencies {
  search: typeof searchAssetsByDescriptionDetailed;
  getAsset: (
    assetId: string,
  ) => Promise<{ userId: string | null; reviewStatus: string } | null>;
}

const compatibilityMatchDependencies: CompatibilityMatchDependencies = {
  search: searchAssetsByDescriptionDetailed,
  getAsset: getAssetRecord,
};

function unmatchedSegment(
  segment: AlignedCompatibilitySegment,
  diagnostic: Pick<
    DescriptionSearchResult,
    "maxScore" | "reason" | "message"
  >,
): MatchedCompatibilitySegment {
  const reason = diagnostic.reason === "matched"
    ? "no_candidates"
    : diagnostic.reason;
  return {
    ...segment,
    matched_candidate_url: null,
    matched_candidate_type: null,
    matched_candidate_desc: null,
    matched_candidate_score: diagnostic.maxScore,
    matched_candidate_reason: reason,
    matched_candidate_message:
      diagnostic.message ?? "没有可用的匹配素材。",
  };
}

export async function matchCompatibilitySegments(
  segments: AlignedCompatibilitySegment[],
  publicOrigin: string,
  dependencies: CompatibilityMatchDependencies = compatibilityMatchDependencies,
) {
  return mapConcurrent(segments, maximumConcurrentMatches, async (segment) => {
    const search = await dependencies.search(
      { description: segment.text, keywords: [], limit: 1 },
      { includeAllUsers: true },
    );
    const [candidate] = search.items;
    if (!candidate) return unmatchedSegment(segment, search);
    const record = await dependencies.getAsset(candidate.id);
    const rawCandidateScore =
      candidate.semanticScore ?? candidate.searchScore ?? search.maxScore ?? 0;
    const candidateScore = Math.min(1, Math.max(0, rawCandidateScore));
    if (!record || record.reviewStatus !== "published") {
      return unmatchedSegment(segment, {
        maxScore: candidateScore,
        reason: "no_candidates",
        message: "匹配到的素材在生成结果前已不可用。",
      });
    }
    return {
      ...segment,
      matched_candidate_url: new URL(
        withUserScope(candidate.mediaUrl, record.userId),
        publicOrigin,
      ).toString(),
      matched_candidate_type: candidate.mediaType,
      matched_candidate_desc: candidate.description,
      matched_candidate_score: candidateScore,
      matched_candidate_reason: null,
      matched_candidate_message: null,
    } satisfies MatchedCompatibilitySegment;
  });
}

async function enqueueCompatibilityCallback(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
  body: Record<string, unknown>,
  now: Date,
) {
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.taskId, taskId), eq(jobs.type, "callback")))
    .limit(1);
  if (existing) return;
  await tx.insert(jobs).values({
    id: crypto.randomUUID(),
    taskId,
    type: "callback",
    phase: "notifying",
    payload: { [callbackPayloadKey]: body },
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function finishCompatibilityTask(
  taskId: string,
  fields: Record<string, unknown>,
  segments: MatchedCompatibilitySegment[],
) {
  const now = new Date();
  const body = {
    ...fields,
    taskId,
    status: "success",
    result: { segments },
    completed_at: compatibilityCompletedAt(now),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "done",
        phase: "finished",
        progressPercent: 100,
        doneItems: 1,
        failedItems: 0,
        result: { segments },
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    await enqueueCompatibilityCallback(tx, taskId, body, now);
  });
}

async function failCompatibilityTask(
  taskId: string,
  fields: Record<string, unknown>,
  error: unknown,
) {
  const now = new Date();
  const failure = persistedTaskError(error);
  const body = {
    ...fields,
    taskId,
    status: "failed",
    error: { code: failure.code, message: failure.message },
    completed_at: compatibilityCompletedAt(now),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        status: "failed",
        phase: "finished",
        progressPercent: 100,
        doneItems: 0,
        failedItems: 1,
        errorCode: failure.code,
        errorMessage: failure.message,
        errorDetails: failure.details ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    await enqueueCompatibilityCallback(tx, taskId, body, now);
  });
}

export async function createCompatibilityMatchTask(
  request: CompatibilityMatchRequest,
  publicOrigin: string,
): Promise<CompatibilityMatchAccepted> {
  const taskId = crypto.randomUUID();
  const now = new Date();
  const config = loadConfig();
  const normalizedOrigin = new URL(publicOrigin).origin;
  await db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id: taskId,
      type: "match",
      status: "queued",
      phase: "matching",
      callbackUrl: request.callback_url,
      totalItems: 1,
      expiresAt: new Date(
        now.getTime() + config.TASK_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      ),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId,
      type: "match",
      phase: "matching",
      payload: {
        request,
        publicOrigin: normalizedOrigin,
        callbackFields: callbackFields(request),
      },
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { taskId, status: "processing" };
}

/** 执行兼容分段任务；素材召回复用详细搜索结果的语义阈值、分数与诊断。 */
export async function processCompatibilityMatchJob(job: ClaimedJob) {
  if (!job.taskId) {
    await failJob(job);
    return;
  }
  let payload: z.infer<typeof compatibilityJobPayloadSchema>;
  try {
    payload = compatibilityJobPayloadSchema.parse(job.payload);
  } catch (error) {
    const normalized =
      error instanceof ZodError
        ? new AppError(
            "invalid_request",
            error.issues[0]?.message ?? "兼容匹配任务参数无效。",
            400,
          )
        : error;
    await failCompatibilityTask(job.taskId, {}, normalized);
    await failJob(job);
    return;
  }

  await db
    .update(tasks)
    .set({
      status: "running",
      phase: "matching",
      startedAt: sql`coalesce(${tasks.startedAt}, ${new Date()})`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, job.taskId));

  try {
    const aligned = alignCompatibilitySegments(payload.request);
    const matched = await matchCompatibilitySegments(
      aligned,
      payload.publicOrigin,
    );
    await finishCompatibilityTask(job.taskId, payload.callbackFields, matched);
    await completeJob(job);
  } catch (error) {
    const retriable =
      !(error instanceof AppError && error.code === "invalid_request") &&
      job.attempt < maximumMatchAttempts;
    if (retriable) {
      await requeueJob(job, job.attempt * 30_000);
      return;
    }
    await failCompatibilityTask(job.taskId, payload.callbackFields, error);
    await failJob(job);
  }
}

export function compatibilityCallbackFromJob(job: ClaimedJob) {
  const body = job.payload?.[callbackPayloadKey];
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
