export const DEFAULT_ANALYZE_TASK_SOFT_LIMIT = 2;

/**
 * 多个任务竞争分析 worker 时执行每任务上限；只有当前任务独占等待队列时才允许突发。
 */
export function canClaimAnalyzeTask(
  runningForTask: number,
  hasCompetingQueuedTask: boolean,
  softLimit = DEFAULT_ANALYZE_TASK_SOFT_LIMIT,
) {
  return runningForTask < softLimit || !hasCompetingQueuedTask;
}
