import { z } from "zod";
import {
  apiTaskStatusSchema,
  apiTaskTypeSchema,
  assetQueryFilterSchema,
  callbackUrlSchema,
  type ApiV1AssetSummary,
  type TaskStatusResponse,
} from "./contracts";

export const matchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  keywords: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  filter: assetQueryFilterSchema.default({ user_scope: { mode: "public" } }),
  limit: z.number().int().min(1).max(100).default(10),
  min_score: z.number().min(0).max(1).default(0),
  callback_url: callbackUrlSchema,
}).strict();
export type MatchRequest = z.infer<typeof matchRequestSchema>;

export interface MatchResult {
  query: string;
  items: ApiV1AssetSummary[];
  matched_count: number;
  min_score: number;
}

export const monitorQuerySchema = z.object({
  status: apiTaskStatusSchema.optional(),
  type: apiTaskTypeSchema.optional(),
  task_id: z.string().uuid().optional(),
  user_id: z.string().trim().min(1).max(191).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type MonitorQuery = z.infer<typeof monitorQuerySchema>;

export const taskLogQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
export type TaskLogQuery = z.infer<typeof taskLogQuerySchema>;

export interface MonitorTask {
  task_id: string;
  task_type: TaskStatusResponse["task_type"];
  status: TaskStatusResponse["status"];
  phase: string;
  user_id: string | null;
  progress_percent: number;
  total_items: number;
  done_items: number;
  failed_items: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  error_message: string | null;
}

export interface MonitorTaskList {
  items: MonitorTask[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  counts: Record<TaskStatusResponse["status"], number>;
}

export interface TaskLog {
  id: number;
  level: "info" | "warn" | "error";
  phase: string;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface TaskLogPage {
  items: TaskLog[];
  next_after: number;
  has_more: boolean;
}

export interface MonitorDetail {
  task: TaskStatusResponse;
  input: Record<string, unknown> | null;
  output: TaskStatusResponse;
  jobs: Array<{
    job_id: string;
    type: string;
    status: string;
    phase: string;
    attempt: number;
    input: Record<string, unknown> | null;
    error_code: string | null;
    error_message: string | null;
    updated_at: string;
  }>;
  callbacks: Array<{
    attempt: number;
    input: Record<string, unknown>;
    status_code: number | null;
    output: string | null;
    error_message: string | null;
    started_at: string;
    completed_at: string | null;
  }>;
}

export const taskTypeLabels: Record<TaskStatusResponse["task_type"], string> = {
  upload: "上传", match: "素材匹配", update: "修改", publish: "发布", delete: "删除", retry: "重试",
};
export const taskStatusLabels: Record<TaskStatusResponse["status"], string> = {
  queued: "排队中", running: "执行中", done: "已完成", failed: "失败",
};
export const taskPhaseLabels: Record<string, string> = {
  receiving: "接收文件", uploading: "上传中", received: "文件已接收", waiting_for_seal: "等待封存",
  sealed: "已封存", queued: "排队中", validating: "校验文件", splitting: "视频分镜", persisting: "持久化",
  analyzing: "模型分析", matching: "语义匹配", publishing: "发布素材", updating: "更新素材",
  retrying: "准备重试", deleting: "删除素材", notifying: "投递回调", finished: "结束",
  embedding: "生成向量", indexing: "更新索引", validate: "校验作业", analyze: "分析作业", embed: "索引作业", callback: "回调作业", match: "匹配作业",
};
