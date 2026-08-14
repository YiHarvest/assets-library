import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import { loadConfig } from "../config";
import type { AssetListInput, AssetSearchInput, CreateUploadInput } from "../contracts/schemas";
import { DatabaseService } from "../database/database.service";
import {
  analysisResults,
  assets,
  assetTags,
  jobs,
  mediaObjects,
  tags,
  taskFiles,
  tasks,
  videoSources,
} from "../database/schema";
import { ZosService } from "../storage/zos.service";
import { ChromaClient } from "../search/chroma.client";
import {
  normalizedTagCandidates,
  presentAssetTags,
  publicAssetAnalysis,
} from "./asset-presentation";
import { inspectUploadedObject, isStorageObjectMissingError, UploadObjectTooLargeError } from "./upload-size-policy";
import { isRetryableProcessingState } from "./retry-policy";

type TaskRow = typeof tasks.$inferSelect;
type AssetRow = typeof assets.$inferSelect;

interface AssetCursor { created_at?: string; file_id: string; similarity_score?: number }

export function encodeCursor(cursor: AssetCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): AssetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as AssetCursor;
    if (!parsed.file_id || (parsed.created_at === undefined && parsed.similarity_score === undefined)) throw new Error();
    if (parsed.created_at && Number.isNaN(new Date(parsed.created_at).getTime())) throw new Error();
    if (parsed.similarity_score !== undefined && !Number.isFinite(parsed.similarity_score)) throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException("cursor 无效。");
  }
}

function encodeTaskCursor(createdAt: Date, taskId: string) {
  return Buffer.from(JSON.stringify({ created_at: createdAt.toISOString(), task_id: taskId }), "utf8").toString("base64url");
}

function decodeTaskCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { created_at?: string; task_id?: string };
    const createdAt = new Date(parsed.created_at ?? "");
    if (!parsed.task_id || Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, taskId: parsed.task_id };
  } catch {
    throw new BadRequestException("cursor 无效。");
  }
}

function taskError(row: { errorCode: string | null; errorMessage: string | null; errorDetails: unknown }) {
  return row.errorCode
    ? { code: row.errorCode, message: row.errorMessage ?? "任务失败。", details: row.errorDetails ?? undefined }
    : undefined;
}

export function fileExpired() {
  return new ConflictException({
    error: {
      code: "file_expired",
      message: "临时文件已经过期，请重新上传。",
    },
  });
}

export function storageUnavailable() {
  return new ServiceUnavailableException({
    error: {
      code: "storage_unavailable",
      message: "存储服务暂时不可用，请稍后重试。",
    },
  });
}

@Injectable()
export class ApiService {
  private readonly config = loadConfig();
  private readonly chroma = new ChromaClient();

  constructor(
    private readonly database: DatabaseService,
    private readonly zos: ZosService,
  ) {}

  async createUpload(input: CreateUploadInput) {
    const taskId = randomUUID();
    const now = new Date();
    const targets: Array<{ file_id?: string; video_source_id?: string; upload_url: string }> = [];
    await this.database.db.transaction(async (tx) => {
      await tx.insert(tasks).values({
        id: taskId,
        type: "upload",
        status: "queued",
        phase: "uploading",
        userId: input.user_id,
        callbackUrl: input.callback_url ?? null,
        autoPublish: input.auto_publish,
        totalFiles: input.files.length,
        createdAt: now,
        updatedAt: now,
      });
      for (const [ordinal, file] of input.files.entries()) {
        const stableId = randomUUID();
        const objectId = randomUUID();
        // 永久上传创建阶段不相信扩展名/MIME；complete 后以真实字节解码决定格式。
        const key = this.zos.temporaryKey(stableId, "upload").replace(/\.upload$/, "");
        const name = file.file_name ?? (file.media_type === "video" ? `${stableId}.mp4` : stableId);
        await tx.insert(mediaObjects).values({
          id: objectId,
          bucket: this.zos.bucket,
          objectKey: key,
          publicUrl: this.zos.publicUrl(key),
          mimeType: "application/octet-stream",
          sizeBytes: 0,
          storageClass: "temporary",
          createdAt: now,
          updatedAt: now,
        });
        let videoSourceId: string | null = null;
        if (file.media_type === "video") {
          videoSourceId = stableId;
          await tx.insert(videoSources).values({
            id: stableId,
            taskId,
            userId: input.user_id,
            sourceObjectId: objectId,
            fileName: name,
            sizeBytes: 0,
            status: "queued",
            phase: "uploading",
            createdAt: now,
            updatedAt: now,
          });
        }
        await tx.insert(taskFiles).values({
          id: randomUUID(),
          taskId,
          ordinal,
          fileId: file.media_type === "image" ? stableId : null,
          videoSourceId,
          uploadObjectId: objectId,
          fileName: name,
          mediaType: file.media_type,
          status: "queued",
          phase: "uploading",
          createdAt: now,
          updatedAt: now,
        });
        targets.push({
          ...(file.media_type === "image" ? { file_id: stableId } : { video_source_id: stableId }),
          upload_url: await this.zos.signedPut(key),
        });
      }
    });
    return { task_id: taskId, status: "queued" as const, phase: "uploading" as const, files: targets, created_at: now.toISOString() };
  }

  async completeUpload(taskId: string) {
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) throw new NotFoundException("上传任务不存在。");
    if (task.phase !== "uploading" || task.status !== "queued") return this.getTask(taskId);
    const claimed = await this.database.db
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.phase, "uploading"), eq(tasks.status, "queued")));
    const affectedRows = Number((claimed as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    if (affectedRows !== 1) return this.getTask(taskId);
    const files = await this.database.db
      .select({ file: taskFiles, object: mediaObjects })
      .from(taskFiles)
      .innerJoin(mediaObjects, eq(taskFiles.uploadObjectId, mediaObjects.id))
      .where(eq(taskFiles.taskId, taskId));
    const metadata = await Promise.all(files.map(async ({ file, object }): Promise<PromiseSettledResult<Awaited<ReturnType<ZosService["head"]>>>> => {
      try {
        // 预签名 PUT 不限制 Content-Length；先HEAD，超限立即回收，绝不交给worker下载。
        const head = await inspectUploadedObject(
          { mediaType: file.mediaType, objectKey: object.objectKey },
          this.zos,
          { imageBytes: this.config.MAX_IMAGE_BYTES, videoBytes: this.config.MAX_VIDEO_BYTES },
        );
        return { status: "fulfilled", value: head };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    }));
    const isVideo = files.some(({ file }) => file.mediaType === "video");
    if (isVideo && metadata.some((result) => result.status === "rejected")) {
      const reason = metadata.find((result) => result.status === "rejected") as PromiseRejectedResult;
      const message = reason.reason instanceof Error ? reason.reason.message : "视频直传对象校验失败。";
      const failedAt = new Date();
      await this.database.db.transaction(async (tx) => {
        await tx.update(tasks).set({
          status: "failed", phase: "processing", failedFiles: 1,
          errorCode: "upload_validation_failed", errorMessage: message,
          finishedAt: failedAt,
          purgeAt: new Date(failedAt.getTime() + this.config.TASK_HISTORY_RETENTION_HOURS * 3_600_000),
          updatedAt: failedAt,
        }).where(eq(tasks.id, taskId));
        await tx.update(taskFiles).set({
          status: "failed", phase: "processing", errorCode: "upload_validation_failed",
          errorMessage: message, updatedAt: failedAt,
        }).where(eq(taskFiles.taskId, taskId));
        const videoSourceIds = files.map(({ file }) => file.videoSourceId).filter((id): id is string => Boolean(id));
        if (videoSourceIds.length) {
          await tx.update(videoSources).set({
            status: "failed", phase: "processing", errorCode: "upload_validation_failed",
            errorMessage: message, updatedAt: failedAt,
          }).where(inArray(videoSources.id, videoSourceIds));
        }
      });
      throw new UnprocessableEntityException(
        message,
      );
    }
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      for (const [index, { file, object }] of files.entries()) {
        const result = metadata[index];
        if (result.status === "rejected") {
          await tx.update(taskFiles).set({
            status: "failed",
            phase: "processing",
            errorCode: "upload_validation_failed",
            errorMessage: result.reason instanceof Error ? result.reason.message : "上传对象校验失败。",
            updatedAt: now,
          }).where(eq(taskFiles.id, file.id));
          continue;
        }
        const head = result.value;
        await tx.update(mediaObjects).set({ sizeBytes: head.sizeBytes, mimeType: head.contentType, createdAt: head.lastModified ?? now, updatedAt: now }).where(eq(mediaObjects.id, object.id));
        await tx.update(taskFiles).set({ sizeBytes: head.sizeBytes, status: "queued", phase: "processing", updatedAt: now }).where(eq(taskFiles.id, file.id));
        if (file.videoSourceId) {
          await tx.update(videoSources).set({ sizeBytes: head.sizeBytes, status: "queued", phase: "processing", updatedAt: now }).where(eq(videoSources.id, file.videoSourceId));
        }
        await tx.insert(jobs).values({
          id: randomUUID(), taskId, fileId: file.fileId, videoSourceId: file.videoSourceId,
          type: "validate", status: "queued", payload: { task_file_id: file.id },
          availableAt: now, createdAt: now, updatedAt: now,
        });
      }
      const failedFiles = metadata.filter((result) => result.status === "rejected").length;
      const doneCandidates = metadata.length - failedFiles;
      await tx.update(tasks).set({
        phase: "processing",
        status: doneCandidates > 0 ? "queued" : "failed",
        failedFiles,
        ...(doneCandidates === 0
          ? {
              errorCode: "upload_validation_failed",
              errorMessage: "所有图片直传对象均校验失败。",
              finishedAt: now,
              purgeAt: new Date(now.getTime() + this.config.TASK_HISTORY_RETENTION_HOURS * 3_600_000),
            }
          : {}),
        updatedAt: now,
      }).where(eq(tasks.id, taskId));
    });
    return this.getTask(taskId);
  }

  async getTask(taskId: string) {
    const task = await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) throw new NotFoundException("任务不存在。");
    const files = await this.database.db.query.taskFiles.findMany({ where: eq(taskFiles.taskId, taskId), orderBy: asc(taskFiles.ordinal) });
    const mapped = await Promise.all(files.map(async (file) => {
      const object = file.uploadObjectId ? await this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, file.uploadObjectId) }) : undefined;
      const slices = file.videoSourceId
        ? await this.database.db.select().from(assets).where(eq(assets.videoSourceId, file.videoSourceId)).orderBy(asc(assets.segmentStartMs))
        : [];
      const produced = file.fileId
        ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, file.fileId) })
        : undefined;
      const producedSummary = produced ? await this.mapAsset(produced) : undefined;
      return {
        ...(file.fileId ? { file_id: file.fileId } : {}),
        ...(file.videoSourceId ? { video_source_id: file.videoSourceId } : {}),
        file_name: file.fileName,
        media_type: file.mediaType,
        status: file.status,
        phase: file.phase,
        ...(object?.sizeBytes ? { size_bytes: object.sizeBytes } : {}),
        ...(producedSummary ? {
          media_url: producedSummary.media_url,
          cover_url: producedSummary.cover_url,
          description: producedSummary.description,
          tags: producedSummary.tags,
        } : {}),
        ...(slices.length ? { slices: await Promise.all(slices.map((slice) => this.mapSlice(slice))) } : {}),
        ...(taskError(file) ? { error: taskError(file) } : {}),
      };
    }));
    return {
      task_id: task.id, task_type: task.type, status: task.status, phase: task.phase,
      total_files: task.totalFiles, done_files: task.doneFiles, failed_files: task.failedFiles,
      files: mapped, ...(taskError(task) ? { error: taskError(task) } : {}),
      created_at: task.createdAt.toISOString(), ...(task.finishedAt ? { finished_at: task.finishedAt.toISOString() } : {}),
    };
  }

  async listPending(userId: string | null, cursor: string | null | undefined, limit: number) {
    const conditions = [or(
      and(eq(tasks.status, "queued"), eq(tasks.phase, "uploading")),
      and(inArray(tasks.status, ["queued", "running", "failed"]), eq(tasks.phase, "processing")),
      and(eq(tasks.status, "pending_review"), eq(tasks.phase, "pending_review")),
    )!];
    conditions.push(userId ? eq(tasks.userId, userId) : isNull(tasks.userId));
    if (cursor) {
      const decoded = decodeTaskCursor(cursor);
      conditions.push(or(
        sql`${tasks.createdAt} < ${decoded.createdAt}`,
        and(eq(tasks.createdAt, decoded.createdAt), sql`${tasks.id} < ${decoded.taskId}`),
      )!);
    }
    const rows = await this.database.db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      tasks: await Promise.all(page.map((row) => this.getTask(row.id))),
      next_cursor: rows.length > limit ? encodeTaskCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : null,
      has_more: rows.length > limit,
    };
  }

  async listAssets(input: AssetListInput) {
    return this.queryAssets(input, undefined);
  }

  async searchAssets(input: AssetSearchInput) {
    return this.queryAssets(input, input);
  }

  private async queryAssets(
    input: AssetListInput | AssetSearchInput,
    search: AssetSearchInput | undefined,
  ) {
    const conditions = [];
    if (input.user_id) conditions.push(eq(assets.userId, input.user_id));
    else if (input.exclude_user_id) conditions.push(or(isNull(assets.userId), ne(assets.userId, input.exclude_user_id))!);
    else if (!input.include_all_users) conditions.push(isNull(assets.userId));
    const phases = "phases" in input ? input.phases : ["published" as const];
    conditions.push(inArray(assets.phase, phases));
    if (input.media_type) conditions.push(eq(assets.mediaType, input.media_type));
    if (search?.tags?.all) {
      for (const value of search.tags.all) {
        const normalized = normalizedTagCandidates(value);
        conditions.push(sql`exists (
          select 1 from ${assetTags}
          inner join ${tags} on ${tags.id} = ${assetTags.tagId}
          where ${assetTags.assetId} = ${assets.id}
            and ${tags.normalizedValue} in (${sql.join(normalized.map((candidate) => sql`${candidate}`), sql`, `)})
        )`);
      }
    }
    if (search?.tags?.any?.length) {
      const normalized = [...new Set(search.tags.any.flatMap(normalizedTagCandidates))];
      conditions.push(sql`exists (
        select 1 from ${assetTags}
        inner join ${tags} on ${tags.id} = ${assetTags.tagId}
        where ${assetTags.assetId} = ${assets.id}
          and ${tags.normalizedValue} in (${sql.join(normalized.map((value) => sql`${value}`), sql`, `)})
      )`);
    }
    if (search?.tags?.exclude?.length) {
      const normalized = [...new Set(search.tags.exclude.flatMap(normalizedTagCandidates))];
      conditions.push(sql`not exists (
        select 1 from ${assetTags}
        inner join ${tags} on ${tags.id} = ${assetTags.tagId}
        where ${assetTags.assetId} = ${assets.id}
          and ${tags.normalizedValue} in (${sql.join(normalized.map((value) => sql`${value}`), sql`, `)})
      )`);
    }
    const limit = input.limit;
    // 先验证游标，再执行可能提前返回空结果的向量检索分支；否则同一个非法
    // cursor 会因当前数据是否命中而在 200 与 400 之间漂移。
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    let similarityScores = new Map<string, number>();
    if (search?.description) {
      if (this.chroma.enabled) {
        // 先在 MySQL 应用用户范围、发布状态、媒体类型和标签权限，再把允许的 ID
        // 交给 Chroma；向量库永远不能扩大调用方可见范围。
        const candidates = await this.database.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(...conditions))
          .limit(10_000);
        similarityScores = await this.chroma.search(
          search.description,
          Math.min(candidates.length, 1_000),
          candidates.map((candidate) => candidate.id),
        );
        if (similarityScores.size === 0) {
          return { total_files: 0, image_files: 0, video_files: 0, files: [], next_cursor: null, has_more: false };
        }
        conditions.push(inArray(assets.id, [...similarityScores.keys()]));
      } else {
        conditions.push(like(assets.description, `%${search.description}%`));
      }
    }
    const pageConditions = [...conditions];
    if (cursor?.created_at && !similarityScores.size) {
      const createdAt = new Date(cursor.created_at);
      pageConditions.push(or(
        sql`${assets.createdAt} < ${createdAt}`,
        and(eq(assets.createdAt, createdAt), sql`${assets.id} < ${cursor.file_id}`),
      )!);
    }
    let rows = await this.database.db.select().from(assets).where(and(...pageConditions)).orderBy(desc(assets.createdAt), desc(assets.id)).limit(similarityScores.size ? Math.min(similarityScores.size, 1_000) : limit + 1);
    if (similarityScores.size) {
      rows = rows.sort((left, right) => {
        const scoreDifference = (similarityScores.get(right.id) ?? 0) - (similarityScores.get(left.id) ?? 0);
        return scoreDifference || right.id.localeCompare(left.id);
      });
      if (cursor?.similarity_score !== undefined) {
        rows = rows.filter((row) => {
          const score = similarityScores.get(row.id) ?? 0;
          return score < cursor.similarity_score! || (score === cursor.similarity_score && row.id < cursor.file_id);
        });
      }
    }
    const page = rows.slice(0, limit);
    const [totals] = await this.database.db.select({
      total: sql<number>`count(*)`,
      images: sql<number>`sum(case when ${assets.mediaType} = 'image' then 1 else 0 end)`,
      videos: sql<number>`sum(case when ${assets.mediaType} = 'video' then 1 else 0 end)`,
    }).from(assets).where(and(...conditions));
    return {
      total_files: Number(totals?.total ?? 0),
      image_files: Number(totals?.images ?? 0),
      video_files: Number(totals?.videos ?? 0),
      files: await Promise.all(page.map(async (row) => ({
        ...(await this.mapAsset(row)),
        ...(similarityScores.has(row.id) ? { similarity_score: similarityScores.get(row.id) } : {}),
      }))),
      next_cursor: rows.length > limit
        ? encodeCursor(similarityScores.size
            ? { file_id: page.at(-1)!.id, similarity_score: similarityScores.get(page.at(-1)!.id) ?? 0 }
            : { file_id: page.at(-1)!.id, created_at: page.at(-1)!.createdAt.toISOString() })
        : null,
      has_more: rows.length > limit,
    };
  }

  async assetDetail(fileId: string) {
    const asset = await this.database.db.query.assets.findFirst({ where: and(eq(assets.id, fileId), eq(assets.phase, "published")) });
    if (!asset) throw new NotFoundException("已入库素材不存在。");
    const base = await this.mapAsset(asset);
    const analysis = await this.database.db.query.analysisResults.findFirst({ where: eq(analysisResults.assetId, fileId) });
    const cover = asset.coverObjectId
      ? await this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, asset.coverObjectId) })
      : undefined;
    return {
      ...base,
      ...(asset.durationMs !== null ? { duration_seconds: asset.durationMs / 1000 } : {}),
      ...(asset.mediaType === "video" && cover
        ? { cover: { file_id: cover.id, file_name: `${cover.id}.jpg`, cover_url: cover.publicUrl } }
        : {}),
      analysis: publicAssetAnalysis(asset.mediaType, analysis?.resultJson),
      updated_at: asset.updatedAt.toISOString(),
    };
  }

  async storageUsage(userId: string | null) {
    const scope = and(userId ? eq(assets.userId, userId) : isNull(assets.userId), eq(assets.phase, "published"));
    const [summary] = await this.database.db.select({
      total: sql<number>`count(*)`,
      images: sql<number>`sum(case when ${assets.mediaType} = 'image' then 1 else 0 end)`,
      videos: sql<number>`sum(case when ${assets.mediaType} = 'video' then 1 else 0 end)`,
      imageBytes: sql<number>`sum(case when ${assets.mediaType} = 'image' then ${assets.sizeBytes} else 0 end)`,
      videoBytes: sql<number>`sum(case when ${assets.mediaType} = 'video' then ${assets.sizeBytes} else 0 end)`,
    }).from(assets).where(scope);
    const [coverSummary] = await this.database.db.select({
      bytes: sql<number>`coalesce(sum(${mediaObjects.sizeBytes}), 0)`,
    }).from(assets).innerJoin(mediaObjects, eq(assets.coverObjectId, mediaObjects.id)).where(and(scope, eq(assets.mediaType, "video")));
    const imageBytes = Number(summary?.imageBytes ?? 0);
    const videoBytes = Number(summary?.videoBytes ?? 0) + Number(coverSummary?.bytes ?? 0);
    return { user_id: userId, total_files: Number(summary?.total ?? 0), image_files: Number(summary?.images ?? 0), video_files: Number(summary?.videos ?? 0), total_bytes: imageBytes + videoBytes, image_bytes: imageBytes, video_bytes: videoBytes };
  }

  async queueMutation(type: "update" | "publish" | "retry" | "delete", input: Record<string, unknown>) {
    const taskId = randomUUID();
    const now = new Date();
    const fileId = typeof input.file_id === "string" ? input.file_id : null;
    const videoSourceId = typeof input.video_source_id === "string" ? input.video_source_id : null;
    const requestedUserId = typeof input.user_id === "string" && input.user_id.trim()
      ? input.user_id.trim()
      : null;
    const existingAsset = fileId
      ? await this.database.db.query.assets.findFirst({ where: eq(assets.id, fileId) })
      : undefined;
    const existingVideoSource = videoSourceId
      ? await this.database.db.query.videoSources.findFirst({ where: eq(videoSources.id, videoSourceId) })
      : undefined;
    const originalTaskFile = fileId
      ? await this.database.db.query.taskFiles.findFirst({
          where: type === "delete"
            ? eq(taskFiles.fileId, fileId)
            : and(eq(taskFiles.fileId, fileId), isNotNull(taskFiles.uploadObjectId)),
          orderBy: asc(taskFiles.createdAt),
        })
      : videoSourceId
        ? await this.database.db.query.taskFiles.findFirst({
            where: type === "delete"
              ? eq(taskFiles.videoSourceId, videoSourceId)
              : and(eq(taskFiles.videoSourceId, videoSourceId), isNotNull(taskFiles.uploadObjectId)),
            orderBy: asc(taskFiles.createdAt),
          })
        : undefined;
    const originalTask = originalTaskFile
      ? await this.database.db.query.tasks.findFirst({ where: eq(tasks.id, originalTaskFile.taskId) })
      : undefined;
    if (fileId && !existingAsset && !((type === "retry" || type === "delete") && originalTaskFile)) throw new NotFoundException("素材不存在。");
    if (videoSourceId && !existingVideoSource) throw new NotFoundException("父视频任务不存在。");
    if (type === "update" && existingAsset?.userId !== input.user_id) {
      throw new ForbiddenException("只能修改本人上传的素材。");
    }
    if (type === "publish" && existingAsset) {
      // user_id 目前由前端提供，但仍必须与创建上传任务时记录的归属一致；
      // 否则任意调用方都能把他人的待入库素材改到自己的名下。
      if (existingAsset.userId !== requestedUserId) {
        throw new ForbiddenException("只能入库同一用户范围内的素材。");
      }
      const pendingReview = existingAsset.status === "pending_review" && existingAsset.phase === "pending_review";
      const alreadyPublished = existingAsset.status === "done" && existingAsset.phase === "published";
      if (!pendingReview && !alreadyPublished) {
        throw new ConflictException("只有待入库素材可以入库。");
      }
    }
    if (type === "retry") {
      const owner = existingAsset
        ? existingAsset.userId
        : existingVideoSource
          ? existingVideoSource.userId
          : originalTask?.userId ?? null;
      if (owner !== requestedUserId) {
        throw new ForbiddenException("只能重试同一用户范围内的处理链。");
      }
      const retryable = fileId
        ? existingAsset ?? originalTaskFile
        : existingVideoSource ?? originalTaskFile;
      if (!isRetryableProcessingState(retryable)) {
        throw new ConflictException("只有 failed + processing 且临时对象仍有效的处理链可以重试。");
      }
      const objectId = existingAsset?.mediaObjectId ?? existingVideoSource?.sourceObjectId ?? originalTaskFile?.uploadObjectId;
      const object = objectId ? await this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, objectId) }) : undefined;
      if (!object) throw fileExpired();
      if (object.storageClass !== "temporary") throw fileExpired();
      try {
        await inspectUploadedObject(
          {
            mediaType: existingAsset?.mediaType ?? originalTaskFile?.mediaType ?? "video",
            objectKey: object.objectKey,
          },
          this.zos,
          { imageBytes: this.config.MAX_IMAGE_BYTES, videoBytes: this.config.MAX_VIDEO_BYTES },
        );
      } catch (error) {
        // 只有明确不存在（或因超限已被回收）才是过期；鉴权、超时、5xx不能伪装成过期。
        if (error instanceof UploadObjectTooLargeError || isStorageObjectMissingError(error)) throw fileExpired();
        throw storageUnavailable();
      }
    }
    if (type === "delete") {
      if (existingAsset?.phase === "published") {
        if (existingAsset.userId !== requestedUserId) {
          throw new ForbiddenException(requestedUserId ? "只能删除本人素材。" : "硬删除个人素材必须携带对应 user_id。");
        }
      } else {
        if (!originalTaskFile) throw new NotFoundException("失败上传的原始任务文件不存在。");
        const failedTarget = existingAsset ?? existingVideoSource ?? originalTaskFile;
        if (!failedTarget) throw new NotFoundException("没有找到可删除的失败上传。");
        if (!isRetryableProcessingState(failedTarget)) {
          throw new ConflictException("尚未入库的原始上传只有 failed + processing 状态可以删除。");
        }
        const owner = existingAsset
          ? existingAsset.userId
          : existingVideoSource
            ? existingVideoSource.userId
            : originalTask?.userId ?? null;
        if (owner !== requestedUserId) throw new ForbiddenException("只能删除同一用户范围内的失败上传。");
      }
    }
    const idempotentPublish = type === "publish" && existingAsset?.status === "done" && existingAsset.phase === "published";
    await this.database.db.transaction(async (tx) => {
      await tx.insert(tasks).values({
        id: taskId, type, status: idempotentPublish ? "done" : "queued", phase: idempotentPublish ? "published" : "processing",
        userId: typeof input.user_id === "string" && input.user_id ? input.user_id : null,
        callbackUrl: typeof input.callback_url === "string" ? input.callback_url : null,
        totalFiles: 1,
        doneFiles: idempotentPublish ? 1 : 0,
        finishedAt: idempotentPublish ? now : null,
        purgeAt: idempotentPublish ? new Date(now.getTime() + this.config.TASK_HISTORY_RETENTION_HOURS * 3_600_000) : null,
        createdAt: now, updatedAt: now,
      });
      await tx.insert(taskFiles).values({
        id: randomUUID(), taskId, ordinal: 0, fileId, videoSourceId,
        uploadObjectId: existingAsset?.mediaObjectId ?? existingVideoSource?.sourceObjectId ?? originalTaskFile?.uploadObjectId ?? null,
        fileName: existingAsset?.fileName ?? existingVideoSource?.fileName ?? originalTaskFile?.fileName ?? "unknown",
        mediaType: existingAsset?.mediaType ?? originalTaskFile?.mediaType ?? "video",
        sizeBytes: existingAsset?.sizeBytes ?? existingVideoSource?.sizeBytes ?? originalTaskFile?.sizeBytes ?? 0,
        status: idempotentPublish ? "done" : "queued",
        phase: idempotentPublish ? "published" : "processing",
        createdAt: now, updatedAt: now,
      });
      if (!idempotentPublish) {
        await tx.insert(jobs).values({
          id: randomUUID(), taskId, fileId, videoSourceId, type,
          status: "queued", payload: input, availableAt: now, createdAt: now, updatedAt: now,
        });
      }
    });
    return this.getTask(taskId);
  }

  private async tagValues(assetId: string) {
    const [rows, analysis] = await Promise.all([
      this.database.db
        .select({ value: tags.value, source: assetTags.source })
        .from(assetTags)
        .innerJoin(tags, eq(assetTags.tagId, tags.id))
        .where(eq(assetTags.assetId, assetId)),
      this.database.db.query.analysisResults.findFirst({
        where: eq(analysisResults.assetId, assetId),
      }),
    ]);
    return presentAssetTags(rows, analysis?.resultJson);
  }

  private async mapAsset(row: AssetRow) {
    const [object, cover] = await Promise.all([
      this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, row.mediaObjectId) }),
      row.coverObjectId ? this.database.db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, row.coverObjectId) }) : undefined,
    ]);
    if (!object) throw new Error(`素材 ${row.id} 缺少媒体对象。`);
    return {
      file_id: row.id, file_name: row.fileName, ...(row.videoSourceId ? { video_source_id: row.videoSourceId } : {}),
      user_id: row.userId, media_type: row.mediaType, status: row.status, phase: row.phase,
      description: row.description, tags: await this.tagValues(row.id), size_bytes: row.sizeBytes,
      media_url: object.publicUrl, cover_url: cover?.publicUrl ?? object.publicUrl,
      ...(taskError(row) ? { error: taskError(row) } : {}), created_at: row.createdAt.toISOString(),
    };
  }

  private async mapSlice(row: AssetRow) {
    const mapped = await this.mapAsset(row);
    return {
      file_id: mapped.file_id, file_name: mapped.file_name,
      video_source_id: row.videoSourceId!, media_type: "video" as const,
      status: mapped.status, phase: mapped.phase, media_url: mapped.media_url,
      cover_url: mapped.cover_url, description: mapped.description, tags: mapped.tags,
      size_bytes: mapped.size_bytes, ...(mapped.error ? { error: mapped.error } : {}),
    };
  }

}
