import type { DatabaseConnection } from "@/server/db/connection";
import { buildDeletionDocument, buildSearchDocument } from "./document";
import { loadRecallWork, recordRecallSuccess, type RecallJobPayload } from "./repository";
import { loadSearchBuildRuntime, type SearchBuildRuntime } from "./runtime";
import type { SearchBuildManifest } from "./types";
import { writeSearchDocument } from "./writer";

export async function executeRecallJob(db: DatabaseConnection["db"], job: RecallJobPayload,
  runtime: (manifest: SearchBuildManifest) => Promise<SearchBuildRuntime> = loadSearchBuildRuntime) {
  const work = await loadRecallWork(db, job);
  if (!work) return { status: "superseded" as const };
  const dependencies = await runtime(work.manifest);
  const document = job.deleted ? buildDeletionDocument(job.assetId, job.sourceRevision, work.manifest)
    : buildSearchDocument(work.snapshot!, job.sourceRevision, work.manifest, dependencies.tokenizer);
  const result = await writeSearchDocument(document, work.manifest, dependencies.store, dependencies.embed);
  if (result.status !== "superseded") await recordRecallSuccess(db, job, document.contentHash);
  return result;
}
