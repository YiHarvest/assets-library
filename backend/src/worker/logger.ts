export function workerLog(input: {
  operationId: string;
  taskId?: string | null;
  fileId?: string | null;
  stage: string;
  status: "started" | "progress" | "done" | "failed" | "retrying";
  startedAt?: number;
  attempt?: number;
  progress?: number;
  error?: unknown;
}) {
  const error = input.error;
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: input.status === "failed" ? "error" : "info",
    worker_index: Number(process.env.WORKER_INDEX ?? "1"),
    operation_id: input.operationId, task_id: input.taskId ?? undefined, file_id: input.fileId ?? undefined,
    stage: input.stage, status: input.status, duration_ms: input.startedAt === undefined ? undefined : Date.now() - input.startedAt,
    attempt: input.attempt, progress: input.progress,
    error: error === undefined ? undefined : errorLogDetails(error),
  })}\n`);
}
import { errorLogDetails } from "../common/error-log";
