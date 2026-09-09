import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { evaluateRecall, freezeDataset, judgingPool, runSchema } from "../benchmarks/search/evaluation";

async function main() {
  const { values } = parseArgs({ options: { dataset: { type: "string" }, baseline: { type: "string" }, candidate: { type: "string" },
    pool: { type: "boolean", default: false }, runs: { type: "string", multiple: true }, output: { type: "string" } } });
  if (!values.dataset || !values.output) throw new Error("Usage: evaluate-recall --dataset FILE --output NEW_FILE [--baseline FILE --candidate FILE | --pool --runs FILE ...]");
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const dataset = freezeDataset(await read(values.dataset)).data;
  let report;
  if (values.pool) {
    if (!values.runs?.length) throw new Error("Judging pool requires --runs");
    report = judgingPool(dataset, await Promise.all(values.runs.map(async (path) => runSchema.parse(await read(path)))));
  } else {
    if (!values.baseline || !values.candidate) throw new Error("Evaluation requires --baseline and --candidate");
    report = evaluateRecall(dataset, runSchema.parse(await read(values.baseline)), runSchema.parse(await read(values.candidate)));
  }
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ datasetHash: report.datasetHash, ...("eligibleForCutover" in report ?
    { eligibleForCutover: report.eligibleForCutover, blockers: report.blockers } : { queries: report.queries.length,
      replayedQueries: report.queries.filter((query) => query.replayedSystems.length).length,
      candidatePairs: report.queries.reduce((sum, query) => sum + query.judgments.length, 0), pendingVisualReview: true }) }));
  if ("eligibleForCutover" in report && !report.eligibleForCutover) process.exitCode = 2;
}
main().catch((error: unknown) => {
  // Validation errors may embed business text; only explicit usage errors are shown.
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Recall evaluation failed; check artifact schema, fingerprints and output path.");
  process.exitCode = 1;
});
