export type SegmentJobState = {
  status: "queued" | "running" | "done" | "failed";
  updatedAt: Date;
};

export type FinalizeJobState = SegmentJobState | undefined;

/** 只有至少一个切片且全部进入 done/failed 后，才允许父任务汇总。 */
export function segmentJobsReadyForFinalize(segmentJobs: SegmentJobState[]) {
  return segmentJobs.length > 0
    && segmentJobs.every((job) => job.status === "done" || job.status === "failed");
}

/**
 * 没有汇总作业时必须创建；已有汇总作业仅在切片后来被重试并产生更新结果时
 * 才重新排队。running 作业由 stale-job 恢复机制负责，不能重复创建。
 */
export function shouldScheduleVideoFinalize(
  segmentJobs: SegmentJobState[],
  finalizeJob: FinalizeJobState,
) {
  if (!segmentJobsReadyForFinalize(segmentJobs)) return false;
  if (!finalizeJob) return true;
  if (finalizeJob.status === "running") return false;
  const latestSegmentAt = Math.max(...segmentJobs.map((job) => job.updatedAt.getTime()));
  return finalizeJob.updatedAt.getTime() < latestSegmentAt;
}
