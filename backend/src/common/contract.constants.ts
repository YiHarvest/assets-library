export const MEDIA_TYPES = ["image", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "failed",
  "pending_review",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PHASES = [
  "uploading",
  "processing",
  "pending_review",
  "published",
  "expired",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const TASK_TYPES = [
  "upload",
  "publish",
  "update",
  "retry",
  "delete",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ASSET_PHASE_FILTERS = [
  "processing",
  "pending_review",
  "published",
  "expired",
] as const;

export const MAX_IMAGE_FILES = 9;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
