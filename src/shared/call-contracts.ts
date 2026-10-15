import { z } from "zod";

export const callQuerySchema = z.object({
  kind: z.enum(["api", "function", "match"]).optional(),
  status: z.enum(["running", "done", "failed"]).optional(),
  task_id: z.string().uuid().optional(),
  trace_id: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type CallQuery = z.infer<typeof callQuerySchema>;

export interface CallRecord {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  task_id: string | null;
  kind: "api" | "function" | "match";
  name: string;
  status: "running" | "done" | "failed";
  status_code: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  task_status: string | null;
  task_phase: string | null;
  task_progress: number | null;
}
export interface CallList {
  items: CallRecord[];
  total: number;
  page: number;
  has_more: boolean;
}
export interface CallDetail {
  call: CallRecord & { input: unknown; output: unknown; error: unknown };
  logs: Array<{ id: number; level: "info" | "warn" | "error"; message: string; data: unknown; created_at: string }>;
  next_after: number;
  has_more: boolean;
}
export const callKindLabels = { api: "API", function: "Function", match: "Match" };
