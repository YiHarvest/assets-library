import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ASSET_PHASE_FILTERS,
  MEDIA_TYPES,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_TYPES,
  type MediaType,
  type TaskPhase,
  type TaskStatus,
  type TaskType,
} from "../common/contract.constants";

export class ApiErrorDto {
  @ApiProperty({ example: "file_expired" })
  declare code: string;

  @ApiProperty({ example: "临时文件已经过期，请重新上传。" })
  declare message: string;

  @ApiPropertyOptional({ type: [Object] })
  declare details?: Record<string, unknown>[];
}

export class ErrorResponseDto {
  @ApiProperty({ type: () => ApiErrorDto })
  declare error: ApiErrorDto;
}

export class TemporaryUploadRequestDto {
  @ApiProperty({ example: "user-123" })
  declare user_id: string;

  @ApiProperty({ type: "string", format: "binary", isArray: true })
  declare files: unknown[];
}

export class TemporaryFileResultDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiProperty({ example: "海边.jpg" })
  declare file_name: string;

  @ApiProperty({ enum: ["done", "failed"] })
  declare status: "done" | "failed";

  @ApiPropertyOptional({ format: "uri" })
  declare media_url?: string;

  @ApiPropertyOptional({ format: "uri" })
  declare cover_url?: string;

  @ApiPropertyOptional({ minimum: 0, example: 1837421 })
  declare size_bytes?: number;

  @ApiPropertyOptional({ minimum: 1, example: 1920 })
  declare width?: number;

  @ApiPropertyOptional({ minimum: 1, example: 1080 })
  declare height?: number;

  @ApiPropertyOptional({ minimum: 0, example: 8.6 })
  declare duration_seconds?: number;

  @ApiPropertyOptional({ type: () => ApiErrorDto })
  declare error?: ApiErrorDto;
}

export class TemporaryUploadResponseDto {
  @ApiProperty({ enum: ["done", "failed"] })
  declare status: "done" | "failed";

  @ApiProperty({ minimum: 1, maximum: 9 })
  declare total_files: number;

  @ApiProperty({ minimum: 0 })
  declare done_files: number;

  @ApiProperty({ minimum: 0 })
  declare failed_files: number;

  @ApiProperty({ type: () => [TemporaryFileResultDto] })
  declare files: TemporaryFileResultDto[];

  @ApiProperty({ format: "date-time" })
  declare created_at: string;

  @ApiProperty({ format: "date-time" })
  declare finished_at: string;
}

export class CreateUploadFileDto {
  @ApiProperty({ enum: MEDIA_TYPES })
  declare media_type: MediaType;

  @ApiPropertyOptional({ example: "海边.jpg" })
  declare file_name?: string;
}

export class CreateUploadRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: "user-123" })
  declare user_id?: string | null;

  @ApiPropertyOptional({ default: false })
  declare auto_publish?: boolean;

  @ApiPropertyOptional({ format: "uri" })
  declare callback_url?: string;

  @ApiProperty({ type: () => [CreateUploadFileDto], minItems: 1, maxItems: 9 })
  declare files: CreateUploadFileDto[];
}

export class UploadTargetDto {
  @ApiPropertyOptional({ format: "uuid" })
  declare file_id?: string;

  @ApiPropertyOptional({ format: "uuid" })
  declare video_source_id?: string;

  @ApiProperty({ format: "uri" })
  declare upload_url: string;
}

export class CreateUploadResponseDto {
  @ApiProperty({ format: "uuid" })
  declare task_id: string;

  @ApiProperty({ enum: ["queued"] })
  declare status: "queued";

  @ApiProperty({ enum: ["uploading"] })
  declare phase: "uploading";

  @ApiProperty({ type: () => [UploadTargetDto] })
  declare files: UploadTargetDto[];

  @ApiProperty({ format: "date-time" })
  declare created_at: string;
}

export class CompleteUploadRequestDto {
  @ApiProperty({ format: "uuid" })
  declare task_id: string;
}

export class TaskSliceDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiProperty({ example: "3f611467-1109-424c-93a7-860148560ceb.mp4" })
  declare file_name: string;

  @ApiProperty({ enum: ["video"] })
  declare media_type: "video";

  @ApiProperty({ format: "uuid" })
  declare video_source_id: string;

  @ApiProperty({ enum: TASK_STATUSES })
  declare status: TaskStatus;

  @ApiProperty({ enum: TASK_PHASES })
  declare phase: TaskPhase;

  @ApiPropertyOptional({ format: "uri" })
  declare media_url?: string;

  @ApiPropertyOptional({ format: "uri" })
  declare cover_url?: string;

  @ApiPropertyOptional()
  declare description?: string;

  @ApiPropertyOptional({ type: [String] })
  declare tags?: string[];

  @ApiPropertyOptional({ minimum: 0 })
  declare size_bytes?: number;

  @ApiPropertyOptional({ type: () => ApiErrorDto })
  declare error?: ApiErrorDto;
}

export class TaskFileDto {
  @ApiPropertyOptional({ format: "uuid" })
  declare file_id?: string;

  @ApiPropertyOptional({ format: "uuid" })
  declare video_source_id?: string;

  @ApiProperty({ example: "旅行.mp4" })
  declare file_name: string;

  @ApiProperty({ enum: MEDIA_TYPES })
  declare media_type: MediaType;

  @ApiProperty({ enum: TASK_STATUSES })
  declare status: TaskStatus;

  @ApiProperty({ enum: TASK_PHASES })
  declare phase: TaskPhase;

  @ApiPropertyOptional({ format: "uri" })
  declare media_url?: string;

  @ApiPropertyOptional({ format: "uri" })
  declare cover_url?: string;

  @ApiPropertyOptional()
  declare description?: string;

  @ApiPropertyOptional({ type: [String] })
  declare tags?: string[];

  @ApiPropertyOptional({ minimum: 0 })
  declare size_bytes?: number;

  @ApiPropertyOptional({ type: () => [TaskSliceDto] })
  declare slices?: TaskSliceDto[];

  @ApiPropertyOptional({ type: () => ApiErrorDto })
  declare error?: ApiErrorDto;
}

export class TaskResponseDto {
  @ApiProperty({ format: "uuid" })
  declare task_id: string;

  @ApiProperty({ enum: TASK_TYPES })
  declare task_type: TaskType;

  @ApiProperty({ enum: TASK_STATUSES })
  declare status: TaskStatus;

  @ApiProperty({ enum: TASK_PHASES })
  declare phase: TaskPhase;

  @ApiProperty({ minimum: 0 })
  declare total_files: number;

  @ApiProperty({ minimum: 0 })
  declare done_files: number;

  @ApiProperty({ minimum: 0 })
  declare failed_files: number;

  @ApiProperty({ type: () => [TaskFileDto] })
  declare files: TaskFileDto[];

  @ApiPropertyOptional({ type: () => ApiErrorDto })
  declare error?: ApiErrorDto;

  @ApiProperty({ format: "date-time" })
  declare created_at: string;

  @ApiPropertyOptional({ format: "date-time" })
  declare finished_at?: string;
}

export class PendingTaskListResponseDto {
  @ApiProperty({ type: () => [TaskResponseDto] })
  declare tasks: TaskResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  declare next_cursor: string | null;

  @ApiProperty()
  declare has_more: boolean;
}

export class AssetListRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;

  @ApiPropertyOptional()
  declare include_all_users?: boolean;

  @ApiPropertyOptional()
  declare exclude_user_id?: string;

  @ApiPropertyOptional({ enum: ASSET_PHASE_FILTERS, isArray: true, default: ["published"] })
  declare phases?: (typeof ASSET_PHASE_FILTERS)[number][];

  @ApiPropertyOptional({
    enum: [...MEDIA_TYPES, "all"],
    nullable: true,
    description: "image=图片，video=视频，all、缺失或 null=全部",
  })
  declare media_type?: MediaType | "all" | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  declare cursor?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  declare limit?: number;
}

export class TagFiltersDto {
  @ApiPropertyOptional({ type: [String] })
  declare all?: string[];

  @ApiPropertyOptional({ type: [String] })
  declare any?: string[];

  @ApiPropertyOptional({ type: [String] })
  declare exclude?: string[];
}

export class AssetSearchRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;

  @ApiPropertyOptional()
  declare include_all_users?: boolean;

  @ApiPropertyOptional()
  declare exclude_user_id?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  declare description?: string;

  @ApiPropertyOptional({ type: () => TagFiltersDto })
  declare tags?: TagFiltersDto;

  @ApiPropertyOptional({
    enum: [...MEDIA_TYPES, "all"],
    nullable: true,
    description: "image=图片，video=视频，all、缺失或 null=全部",
  })
  declare media_type?: MediaType | "all" | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  declare cursor?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  declare limit?: number;
}

export class AssetSummaryDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiProperty()
  declare file_name: string;

  @ApiPropertyOptional({ format: "uuid" })
  declare video_source_id?: string;

  @ApiProperty({ type: String, nullable: true })
  declare user_id: string | null;

  @ApiProperty({ enum: MEDIA_TYPES })
  declare media_type: MediaType;

  @ApiProperty({ enum: TASK_STATUSES })
  declare status: TaskStatus;

  @ApiProperty({ enum: TASK_PHASES })
  declare phase: TaskPhase;

  @ApiProperty()
  declare description: string;

  @ApiProperty({ type: [String] })
  declare tags: string[];

  @ApiProperty({ minimum: 0 })
  declare size_bytes: number;

  @ApiProperty({ format: "uri" })
  declare media_url: string;

  @ApiProperty({ format: "uri" })
  declare cover_url: string;

  @ApiPropertyOptional({ type: () => ApiErrorDto, nullable: true })
  declare error?: ApiErrorDto | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  declare similarity_score?: number;

  @ApiProperty({ format: "date-time" })
  declare created_at: string;
}

export class AssetListResponseDto {
  @ApiProperty({ minimum: 0 })
  declare total_files: number;

  @ApiProperty({ minimum: 0 })
  declare image_files: number;

  @ApiProperty({ minimum: 0 })
  declare video_files: number;

  @ApiProperty({ type: () => [AssetSummaryDto] })
  declare files: AssetSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  declare next_cursor: string | null;

  @ApiProperty()
  declare has_more: boolean;
}

export class OcrDto {
  @ApiProperty({ type: String, nullable: true })
  declare text: string | null;

  @ApiProperty({ type: String, nullable: true })
  declare unavailable_reason: string | null;
}

export class ImageAnalysisDto {
  @ApiProperty({ type: () => OcrDto })
  declare ocr: OcrDto;
}

export class TimedSummaryDto {
  @ApiProperty({ minimum: 0 })
  declare start_seconds: number;

  @ApiProperty({ minimum: 0 })
  declare end_seconds: number;

  @ApiProperty()
  declare summary: string;
}

export class KeyMomentDto {
  @ApiProperty({ minimum: 0 })
  declare seconds: number;

  @ApiProperty()
  declare summary: string;
}

export class VideoAnalysisDto {
  @ApiProperty({ type: [String] })
  declare topics: string[];

  @ApiProperty({ type: () => [TimedSummaryDto] })
  declare visual_segments: TimedSummaryDto[];

  @ApiProperty({ type: () => [KeyMomentDto] })
  declare key_moments: KeyMomentDto[];

  @ApiProperty({ type: () => [TimedSummaryDto] })
  declare timeline: TimedSummaryDto[];
}

export class VideoCoverDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiProperty()
  declare file_name: string;

  @ApiProperty({ format: "uri" })
  declare cover_url: string;
}

export class AssetDetailDto extends AssetSummaryDto {
  @ApiPropertyOptional({ minimum: 0 })
  declare duration_seconds?: number;

  @ApiPropertyOptional({ type: () => VideoCoverDto })
  declare cover?: VideoCoverDto;

  @ApiProperty({ oneOf: [
    { $ref: "#/components/schemas/ImageAnalysisDto" },
    { $ref: "#/components/schemas/VideoAnalysisDto" },
  ] })
  declare analysis: ImageAnalysisDto | VideoAnalysisDto;

  @ApiProperty({ format: "date-time" })
  declare updated_at: string;
}

export class UpdateAssetRequestDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiProperty()
  declare user_id: string;

  @ApiPropertyOptional()
  declare file_name?: string;

  @ApiPropertyOptional()
  declare description?: string;

  @ApiPropertyOptional({ type: [String] })
  declare tags?: string[];

  @ApiPropertyOptional({ format: "uri" })
  declare callback_url?: string;
}

export class PublishAssetRequestDto {
  @ApiProperty({ format: "uuid" })
  declare file_id: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;

  @ApiPropertyOptional({ format: "uri" })
  declare callback_url?: string;
}

export class RetryAssetRequestDto {
  @ApiPropertyOptional({ format: "uuid" })
  declare file_id?: string;

  @ApiPropertyOptional({ format: "uuid" })
  declare video_source_id?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;

  @ApiPropertyOptional({ format: "uri" })
  declare callback_url?: string;
}

export class DeleteAssetRequestDto {
  @ApiPropertyOptional({ format: "uuid", description: "图片、视频切片或尚未产出asset行的原始图片file_id。" })
  declare file_id?: string;

  @ApiPropertyOptional({ format: "uuid", description: "尚未产出切片asset行的失败父视频video_source_id。" })
  declare video_source_id?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;

  @ApiPropertyOptional({ format: "uri" })
  declare callback_url?: string;
}

export class StorageUsageRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  declare user_id?: string | null;
}

export class StorageUsageResponseDto {
  @ApiProperty({ type: String, nullable: true })
  declare user_id: string | null;

  @ApiProperty({ minimum: 0 })
  declare total_files: number;

  @ApiProperty({ minimum: 0 })
  declare image_files: number;

  @ApiProperty({ minimum: 0 })
  declare video_files: number;

  @ApiProperty({ minimum: 0 })
  declare total_bytes: number;

  @ApiProperty({ minimum: 0 })
  declare image_bytes: number;

  @ApiProperty({ minimum: 0 })
  declare video_bytes: number;
}
