import {
  claimNextJob,
  deleteExpiredTasks,
  recoverStaleJobs,
  requeueFailedEmbeddingJobs,
} from "@/server/repositories/assets";
import { loadConfig } from "@/server/config";
import { OpenAICompatibleAnalyzer } from "@/server/model/analyzer";
import { startWorkerHeartbeat } from "@/server/health/worker-heartbeat";
import { processJob } from "@/server/services/processing";
import { cleanupExpiredPendingAssets } from "@/server/services/pending-asset-cleanup";
import {
  cleanupExpiredStaging,
  expireAbandonedUploadTasks,
} from "@/server/services/staging-cleanup";
import { reconcileActiveTaskLifecycles } from "@/server/services/task-lifecycle";

const pollIntervalMs = 1_000;
const recoveryIntervalMs = 30_000;
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  const config = loadConfig();
  const cleanupIntervalMs = config.CLEANUP_INTERVAL_SECONDS * 1_000;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  try {
    const analyzer = new OpenAICompatibleAnalyzer(config);
    await recoverStaleJobs();
    await reconcileActiveTaskLifecycles();
    const requeuedEmbeddings = await requeueFailedEmbeddingJobs();
    if (requeuedEmbeddings > 0) {
      console.log(`Requeued ${requeuedEmbeddings} failed embedding job(s).`);
    }
    recoveryTimer = setInterval(() => {
      void recoverStaleJobs()
        .then((recovered) => {
          if (recovered > 0) {
            console.log(`Recovered ${recovered} stale processing job(s).`);
          }
        })
        .catch((error) => {
          console.error("Failed to recover stale jobs.", error);
        });
    }, recoveryIntervalMs);
    // pending 过期会把原上传任务重新置为 failed 并延长查询期，必须先于任务清理。
    await cleanupExpiredPendingAssets();
    await Promise.all([
      cleanupExpiredStaging(),
      expireAbandonedUploadTasks(),
      deleteExpiredTasks(),
      reconcileActiveTaskLifecycles(),
    ]);
    cleanupTimer = setInterval(() => {
      void Promise.all([
        cleanupExpiredStaging(),
        expireAbandonedUploadTasks(),
        (async () => {
          const removedPendingAssets = await cleanupExpiredPendingAssets();
          const removedTasks = await deleteExpiredTasks();
          return { removedPendingAssets, removedTasks };
        })(),
        reconcileActiveTaskLifecycles(),
      ])
        .then(
          ([
            removedFiles,
            expiredUploads,
            durableCleanup,
            reconciledTasks,
          ]) => {
            const { removedPendingAssets, removedTasks } = durableCleanup;
            if (removedFiles > 0) {
              console.log(`Removed ${removedFiles} expired staging task(s).`);
            }
            if (expiredUploads > 0) {
              console.log(
                `Marked ${expiredUploads} abandoned upload task(s) as failed.`,
              );
            }
            if (removedPendingAssets > 0) {
              console.log(
                `Removed ${removedPendingAssets} expired pending asset(s).`,
              );
            }
            if (removedTasks > 0) {
              console.log(`Removed ${removedTasks} expired task record(s).`);
            }
            if (reconciledTasks > 0) {
              console.log(
                `Reconciled ${reconciledTasks} active task lifecycle(s).`,
              );
            }
          },
        )
        .catch((error) => {
          console.error("Failed to clean expired staging files.", error);
        });
    }, cleanupIntervalMs);
    cleanupTimer.unref();
    const vlmChain =
      config.models.vlmCandidates.map((model) => model.name).join(" -> ") ||
      "not configured";
    const llmChain =
      config.models.llmCandidates.map((model) => model.name).join(" -> ") ||
      "not configured";
    // 只有数据库恢复和首次清理都完成后才进入 ready；避免初始化卡住时留下
    // 看似新鲜、实则不能领取任务的假健康心跳。
    stopHeartbeat = await startWorkerHeartbeat();
    console.log(
      `Asset processing worker started (VLM chain: ${vlmChain}, LLM chain: ${llmChain}, VLM protocol: ${config.models.vlm.protocol}).`,
    );
    while (!stopping) {
      const job = await claimNextJob();
      if (job) {
        await processJob(job, analyzer);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    console.log("Asset processing worker stopped.");
  } finally {
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (stopHeartbeat) await stopHeartbeat();
  }
}

void main().catch((error: unknown) => {
  console.error("Asset processing worker exited unexpectedly.", error);
  process.exitCode = 1;
});
