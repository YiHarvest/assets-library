import {
  claimNextJob,
  deleteExpiredTasks,
  recoverStaleJobs,
  requeueFailedEmbeddingJobs,
} from "@/server/repositories/assets";
import { loadConfig } from "@/server/config";
import { OpenAICompatibleAnalyzer } from "@/server/model/analyzer";
import { processJob } from "@/server/services/processing";
import {
  cleanupExpiredAnalysisWorkspaces,
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

async function workerLoop(
  workerId: number,
  analyzer: OpenAICompatibleAnalyzer,
  analyzeTaskSoftLimit: number,
) {
  const leaseOwner = `${process.pid}:${workerId}`;
  while (!stopping) {
    try {
      const job = await claimNextJob(leaseOwner, { analyzeTaskSoftLimit });
      if (job) {
        await processJob(job, analyzer);
        continue;
      }
    } catch (error) {
      console.error(`Worker loop ${workerId} failed; retrying.`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function main() {
  const config = loadConfig();
  const cleanupIntervalMs = config.CLEANUP_INTERVAL_SECONDS * 1_000;
  const analyzer = new OpenAICompatibleAnalyzer(config);
  await recoverStaleJobs();
  await reconcileActiveTaskLifecycles();
  const requeuedEmbeddings = await requeueFailedEmbeddingJobs();
  if (requeuedEmbeddings > 0) {
    console.log(`Requeued ${requeuedEmbeddings} failed embedding job(s).`);
  }
  const recoveryTimer = setInterval(() => {
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
  await Promise.all([
    cleanupExpiredStaging(),
    cleanupExpiredAnalysisWorkspaces(),
    expireAbandonedUploadTasks(),
    deleteExpiredTasks(),
    reconcileActiveTaskLifecycles(),
  ]);
  const cleanupTimer = setInterval(() => {
    void Promise.all([
      cleanupExpiredStaging(),
      cleanupExpiredAnalysisWorkspaces(),
      expireAbandonedUploadTasks(),
      deleteExpiredTasks(),
      reconcileActiveTaskLifecycles(),
    ])
      .then(
        ([
          removedFiles,
          removedAnalysisWorkspaces,
          expiredUploads,
          removedTasks,
          reconciledTasks,
        ]) => {
        if (removedFiles > 0) {
          console.log(`Removed ${removedFiles} expired staging task(s).`);
        }
        if (removedAnalysisWorkspaces > 0) {
          console.log(
            `Removed ${removedAnalysisWorkspaces} expired analysis workspace(s).`,
          );
        }
        if (expiredUploads > 0) {
          console.log(`Marked ${expiredUploads} abandoned upload task(s) as failed.`);
        }
        if (removedTasks > 0) {
          console.log(`Removed ${removedTasks} expired task record(s).`);
        }
        if (reconciledTasks > 0) {
          console.log(`Reconciled ${reconciledTasks} active task lifecycle(s).`);
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
  console.log(
    `Asset processing worker started (${config.WORKER_CONCURRENCY} concurrent loops, per-task analyze soft limit: ${config.WORKER_ANALYZE_TASK_SOFT_LIMIT}, validate priority enabled, VLM chain: ${vlmChain}, LLM chain: ${llmChain}, VLM protocol: ${config.models.vlm.protocol}).`,
  );
  await Promise.all(
    Array.from({ length: config.WORKER_CONCURRENCY }, (_, index) =>
      workerLoop(
        index + 1,
        analyzer,
        config.WORKER_ANALYZE_TASK_SOFT_LIMIT,
      ),
    ),
  );
  clearInterval(recoveryTimer);
  clearInterval(cleanupTimer);
  console.log("Asset processing worker stopped.");
}

void main();
