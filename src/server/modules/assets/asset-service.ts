import { ApiV1Error } from "@/server/api/errors";
import type { AppConfig } from "@/server/config";
import type { TaskService } from "@/server/modules/tasks/task-service";
import type * as AssetRepository from "@/server/repositories/assets";
import type { AssetScope } from "@/server/repositories/assets";
import type {
  ApiTaskStatus,
  ApiV1AssetDetail,
  ApiV1AssetSummary,
  AssetQuery,
  AssetQueryResponse,
  AssetSummary,
  AnalysisResult,
  MutationContext,
  ProcessingStatus,
  UpdateAssetTask,
  UserScope,
} from "@/shared/contracts";

type AssetsRepository = Pick<
  typeof AssetRepository,
  | "createMutationTask"
  | "getAssetDetail"
  | "getAssetRecord"
  | "queryAssetsPage"
>;

export interface AssetServiceDependencies {
  config: () => AppConfig;
  repository: AssetsRepository;
  tasks: Pick<TaskService, "getAcceptedTask">;
}

export function scopeForRepository(scope: UserScope): AssetScope {
  switch (scope.mode) {
    case "user":
      return { userId: scope.user_id };
    case "all":
      return { includeAllUsers: true };
    case "exclude_user":
      return { excludeUserId: scope.user_id };
    default:
      return {};
  }
}

export function scopeForAssetQuery(
  input: Pick<AssetQuery, "filter" | "keywords">,
): AssetScope {
  return scopeForRepository(input.filter.user_scope);
}

function encodeCursor(page: number) {
  return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null) {
  if (!cursor) return 1;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { page?: unknown };
    if (Number.isInteger(value.page) && Number(value.page) > 0) {
      return Number(value.page);
    }
  } catch {
    // 统一在下面返回公开的请求错误，避免暴露解析细节。
  }
  throw new ApiV1Error("invalid_request", "cursor 无效或已经过期。", 400);
}

function processingStatusesFromApi(statuses: ApiTaskStatus[] | undefined) {
  if (!statuses?.length) return [];
  const mapped = new Set<ProcessingStatus>();
  for (const status of statuses) {
    if (status === "queued") mapped.add("queued");
    if (status === "running") {
      mapped.add("validating");
      mapped.add("analyzing");
    }
    if (status === "done") mapped.add("completed");
    if (status === "failed") mapped.add("failed");
  }
  return [...mapped];
}

function taskStatusFromProcessing(status: string): ApiTaskStatus {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "running";
}

function shanghaiIso(value: Date | null) {
  if (!value) return null;
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

/** 数据库保留模型原始契约；API v1 在边界统一转换为 snake_case。 */
function apiAnalysis(result: AnalysisResult | null) {
  if (!result) return null;
  if (result.kind === "image") {
    return {
      kind: result.kind,
      description: result.description,
      tags: result.tags,
      ocr: {
        text: result.ocr.text,
        unavailable_reason: result.ocr.unavailableReason,
      },
    } as const;
  }
  const timed = (item: {
    startSeconds: number;
    endSeconds: number;
    summary: string;
  }) => ({
    start_seconds: item.startSeconds,
    end_seconds: item.endSeconds,
    summary: item.summary,
  });
  return {
    kind: result.kind,
    description: result.description,
    topics: result.topics,
    tags: result.tags,
    visual_segments: result.visualSegments.map(timed),
    key_moments: result.keyMoments.map((item) => ({
      seconds: item.seconds,
      summary: item.summary,
    })),
    timeline: result.timeline.map(timed),
  } as const;
}

export class AssetService {
  constructor(private readonly dependencies: AssetServiceDependencies) {}

  private async assetSummary(asset: AssetSummary) {
    const record = await this.dependencies.repository.getAssetRecord(asset.id);
    if (!record) throw new ApiV1Error("not_found", "素材不存在。", 404);
    const mediaUrl = record.userId
      ? `${asset.mediaUrl}${asset.mediaUrl.includes("?") ? "&" : "?"}user_id=${encodeURIComponent(record.userId)}`
      : asset.mediaUrl;
    return {
      asset_id: asset.id,
      parent_video_id: record.videoSourceId,
      segment_index: record.segmentIndex,
      user_id: record.userId,
      name: asset.name,
      description: asset.description,
      media_type: asset.mediaType,
      status: taskStatusFromProcessing(asset.processingStatus),
      review_status: asset.reviewStatus,
      tags: asset.tags,
      media_url: mediaUrl,
      created_at: shanghaiIso(record.createdAt)!,
      updated_at: shanghaiIso(record.updatedAt)!,
      ...(asset.searchScore === undefined
        ? {}
        : { search_score: asset.searchScore }),
      ...(asset.keywordScore === undefined
        ? {}
        : { keyword_score: asset.keywordScore }),
      ...(asset.semanticScore === undefined
        ? {}
        : { semantic_score: asset.semanticScore }),
      ...(asset.matchType === undefined
        ? {}
        : { match_type: asset.matchType }),
      ...(asset.matchedTerms === undefined
        ? {}
        : { matched_terms: asset.matchedTerms }),
      ...(asset.matchedCategories === undefined
        ? {}
        : { matched_categories: asset.matchedCategories }),
    } satisfies ApiV1AssetSummary;
  }

  async queryAssets(
    input: AssetQuery,
  ): Promise<AssetQueryResponse> {
    if (input.query && input.cursor) {
      throw new ApiV1Error(
        "invalid_request",
        "语义检索返回单页 top-k 结果，不支持 cursor。",
        400,
      );
    }
    const pageNumber = input.query ? 1 : decodeCursor(input.cursor);
    const scope = scopeForAssetQuery(input);
    const result = await this.dependencies.repository.queryAssetsPage({
      ...scope,
      page: pageNumber,
      limit: input.limit,
      mediaTypes: input.filter.media_types,
      processingStatuses: processingStatusesFromApi(input.filter.statuses),
      reviewStatuses: input.filter.review_statuses ?? ["published"],
      tags: input.filter.tags,
      keywords: input.keywords,
      semanticQuery: input.query,
      includeTagStatistics: input.include_tag_statistics,
    });
    const mapped = await Promise.all(
      result.items.map((item) => this.assetSummary(item)),
    );
    const hasMore = input.query ? false : result.page < result.totalPages;
    return {
      items: mapped,
      next_cursor: hasMore ? encodeCursor(result.page + 1) : null,
      has_more: hasMore,
      tag_statistics: input.include_tag_statistics
        ? (result.tagStatistics ?? null)
        : null,
      search: result.search ?? null,
    };
  }

  async getAsset(assetId: string, scope: UserScope): Promise<ApiV1AssetDetail> {
    const detail = await this.dependencies.repository.getAssetDetail(
      assetId,
      scopeForRepository(scope),
    );
    const summary = await this.assetSummary(detail);
    return {
      ...summary,
      original_filename: detail.originalFilename,
      mime_type: detail.mimeType,
      size_bytes: detail.sizeBytes,
      segment_start_seconds:
        detail.segmentStartMs === null ? null : detail.segmentStartMs / 1_000,
      segment_end_seconds:
        detail.segmentEndMs === null ? null : detail.segmentEndMs / 1_000,
      failure:
        detail.failureCode || detail.failureMessage
          ? {
              code:
                detail.failureCode === "multiple_files"
                  ? "invalid_request"
                  : (detail.failureCode ?? "internal_error"),
              message: detail.failureMessage ?? "素材处理失败。",
            }
          : null,
      analysis: apiAnalysis(detail.analysis),
    };
  }

  updateAsset(assetId: string, input: UpdateAssetTask) {
    return this.createMutationTask("update", assetId, input, {
      name: input.name,
      description: input.description,
      tags: input.tags,
    });
  }

  publishAsset(assetId: string, input: MutationContext) {
    return this.createMutationTask("publish", assetId, input);
  }

  retryAsset(assetId: string, input: MutationContext) {
    return this.createMutationTask("retry", assetId, input);
  }

  deleteAsset(assetId: string, input: MutationContext) {
    return this.createMutationTask("delete", assetId, input);
  }

  private async createMutationTask(
    type: "delete" | "publish" | "update" | "retry",
    assetId: string,
    context: MutationContext,
    payload: Record<string, unknown> = {},
  ) {
    const config = this.dependencies.config();
    const { task } = await this.dependencies.repository.createMutationTask({
      type,
      assetId,
      userId: context.user_id,
      callbackUrl: context.callback_url,
      expiresAt: new Date(
        Date.now() + config.TASK_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      ),
      payload: { ...payload, userId: context.user_id },
    });
    return this.dependencies.tasks.getAcceptedTask(task.id);
  }
}
