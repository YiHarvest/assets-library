import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fingerprint, hashText } from "../src/server/search/v2/fingerprint";
import { freezeDataset, type EvaluationDataset } from "../benchmarks/search/evaluation";

async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, limit: { type: "string", default: "200" },
    seed: { type: "string", default: "recall-judging-draft-v1" } } });
  const limit = Number(values.limit);
  if (!values.input || !values.output || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Usage: prepare-recall-judging-draft --input FILE --output NEW_FILE [--limit 200 --seed LABEL]");
  const input = JSON.parse(await readFile(values.input, "utf8"));
  if (input.stage !== "unjudged-input" || fingerprint(input.sources) !== input.sourceSnapshotHash) throw new Error("Source snapshot differs");
  type StagedQuery = { id: string; text: string; taskGroups: string[]; eligibleAssetIds: string[] };
  const groups = new Map<string, StagedQuery[]>();
  for (const query of input.queries as StagedQuery[]) {
    const group = query.taskGroups[0];
    if (!group) throw new Error("Query provenance missing");
    const bucket = groups.get(group) ?? []; bucket.push(query); groups.set(group, bucket);
  }
  const seededOrder = (id: string) => hashText(`${values.seed}:${id}`);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = [...groups.entries()].sort(([a], [b]) => compare(seededOrder(a), seededOrder(b)))
    .map(([, queries]) => queries.sort((a, b) => compare(seededOrder(a.id), seededOrder(b.id))));
  const selected: StagedQuery[] = [];
  for (let round = 0; selected.length < limit; round++) {
    const current = ordered.flatMap((queries) => queries[round] ? [queries[round]] : []);
    if (!current.length) break;
    selected.push(...current.slice(0, limit - selected.length));
  }
  const draft: EvaluationDataset = { schemaVersion: 1, frozenAt: new Date().toISOString(), provenance: "business",
    sourceSnapshotHash: input.sourceSnapshotHash,
    assets: input.sources.map((row: { assetId: string; sourceGroup: string }) => ({ assetId: row.assetId, sourceGroup: row.sourceGroup, partition: "tune" })),
    queries: selected.map((query) => ({ id: query.id, text: query.text, entry: "segment-match", group: `unreviewed-task:${query.taskGroups[0]}`,
      partition: "tune", eligibleAssetIds: query.eligibleAssetIds, noMatch: null, poolComplete: false, judgments: [] })) };
  const frozen = freezeDataset(draft);
  await writeFile(values.output, `${JSON.stringify(frozen.data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ datasetHash: frozen.hash, assets: draft.assets.length, queries: selected.length,
    taskProvenanceGroups: new Set(selected.map((query) => query.taskGroups[0])).size, seed: values.seed,
    testQueries: 0, labelsAssigned: 0, note: "All rows are unjudged tuning drafts; task provenance does not replace reviewed topic grouping. Prepare an independent test split before quality evaluation." }));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Judging draft preparation failed; check source fingerprint and output path.");
  process.exitCode = 1;
});
