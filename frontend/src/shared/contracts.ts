export type MediaType = "image" | "video";
export type ApiTaskStatus =
  | "queued"
  | "running"
  | "failed"
  | "pending_review"
  | "done";
export type ApiTaskPhase =
  | "uploading"
  | "processing"
  | "pending_review"
  | "published"
  | "expired";

export interface ApiError {
  code: string;
  message: string;
  details?: Array<Record<string, unknown>>;
}

export interface AssetSummary {
  file_id: string;
  file_name: string;
  video_source_id?: string;
  user_id: string | null;
  media_type: MediaType;
  status: ApiTaskStatus;
  phase: ApiTaskPhase;
  description: string;
  tags: string[];
  size_bytes: number;
  media_url: string;
  cover_url: string;
  error?: ApiError | null;
  similarity_score?: number;
  created_at: string;
}

export interface AssetListResponse {
  total_files: number;
  image_files: number;
  video_files: number;
  files: AssetSummary[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ImageAnalysis {
  ocr: { text: string | null; unavailable_reason: string | null };
}

export interface TimedSummary {
  start_seconds: number;
  end_seconds: number;
  summary: string;
}

export interface VideoAnalysis {
  topics: string[];
  visual_segments: TimedSummary[];
  key_moments: Array<{ seconds: number; summary: string }>;
  timeline: TimedSummary[];
}

export interface AssetDetail extends AssetSummary {
  duration_seconds?: number;
  cover?: { file_id: string; file_name: string; cover_url: string };
  analysis: ImageAnalysis | VideoAnalysis;
  updated_at: string;
}

export interface UploadTarget {
  file_id?: string;
  video_source_id?: string;
  upload_url: string;
}

export interface CreateUploadResponse {
  task_id: string;
  status: "queued";
  phase: "uploading";
  files: UploadTarget[];
  created_at: string;
}

export interface TaskFile {
  file_id?: string;
  video_source_id?: string;
  file_name: string;
  media_type: MediaType;
  status: ApiTaskStatus;
  phase: ApiTaskPhase;
  media_url?: string;
  cover_url?: string;
  description?: string;
  tags?: string[];
  size_bytes?: number;
  slices?: TaskFile[];
  error?: ApiError;
}

export interface TaskResponse {
  task_id: string;
  task_type: "upload" | "update" | "publish" | "retry" | "delete";
  status: ApiTaskStatus;
  phase: ApiTaskPhase;
  total_files: number;
  done_files: number;
  failed_files: number;
  files: TaskFile[];
  error?: ApiError;
  created_at: string;
  finished_at?: string;
}

export interface PendingTaskListResponse {
  tasks: TaskResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export type TaskAccepted = Pick<TaskResponse, "task_id" | "status" | "phase"> &
  Partial<TaskResponse>;
