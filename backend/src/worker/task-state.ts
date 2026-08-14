export type CountedFileState = {
  status: "queued" | "running" | "failed" | "pending_review" | "done";
  phase: "uploading" | "processing" | "pending_review" | "published" | "expired";
  count: number;
};

/** 上传直传阶段由 /uploads/complete 独占，维护任务不得提前推进状态机。 */
export function shouldReconcileUploadTask(status: string, phase: string) {
  return ((status === "queued" || status === "running") && phase === "processing")
    || (status === "failed" && phase === "processing")
    || (status === "pending_review" && phase === "pending_review");
}

export function aggregateUploadTask(rows: CountedFileState[], pendingAssets = 0) {
  const count = (status: CountedFileState["status"]) => rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.count, 0);
  const queued = count("queued"); const running = count("running"); const failed = count("failed");
  const pending = count("pending_review"); const done = count("done");
  const processing = queued + running;
  const status = processing > 0 ? "running" : pending + pendingAssets > 0 ? "pending_review" : done > 0 ? "done" : "failed";
  const doneRows = rows.filter((row) => row.status === "done");
  const phase = status === "pending_review" ? "pending_review" : status === "done" ? (doneRows.length > 0 && doneRows.every((row) => row.phase === "expired") ? "expired" : "published") : "processing";
  return { status, phase, totalFiles: queued + running + failed + pending + done, doneFiles: pending + done, failedFiles: failed } as const;
}

export function purgeAtForState(status: string, phase: string, now: Date, retentionHours: number) {
  if (status === "pending_review" || phase === "pending_review") return null;
  if (status !== "done" && status !== "failed") return null;
  return new Date(now.getTime() + retentionHours * 3_600_000);
}

export function videoSourceState(phases: string[]) {
  if (phases.includes("pending_review")) return { status: "pending_review" as const, phase: "pending_review" as const };
  if (phases.includes("published")) return { status: "done" as const, phase: "published" as const };
  return { status: "done" as const, phase: "expired" as const };
}
