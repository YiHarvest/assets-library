/**
 * 多 worker 共享作业队列，但维护循环必须只有一个执行者。否则 callback 和
 * embedding 的“先查后插”会在不同进程间竞争，可能产生重复作业。
 */
export function isMaintenanceWorker(workerIndex: number) {
  return workerIndex === 1;
}
