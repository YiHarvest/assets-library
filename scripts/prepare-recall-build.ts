import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import descriptor from "../config/recall/bge-m3-tokenizer.json";
import deployment from "../config/recall/bge-m3-serving-identity.json";
import { fingerprint } from "../src/server/search/v2/fingerprint";
import { parseSearchManifest } from "../src/server/search/v2/manifest";
import { loadSearchTokenizer } from "../src/server/search/v2/tokenizer";

async function main() {
  const { values } = parseArgs({ options: { "base-index": { type: "string" }, "build-id": { type: "string" }, output: { type: "string" },
    "tokenizer-dir": { type: "string", default: "data/recall-tokenizers/bge-m3" }, chunker: { type: "string", default: "visual-v2" },
    "source-snapshot": { type: "string" } } });
  if (!values["base-index"] || !values["build-id"] || !values.output) throw new Error("Usage: prepare-recall-build --base-index NAME --build-id ID --output NEW_MANIFEST [--tokenizer-dir DIR]");
  if (`sha256:${fingerprint(deployment.identity)}` !== deployment.revision) throw new Error("Deployment identity digest is inconsistent");
  const snapshot = values["source-snapshot"] ? JSON.parse(await readFile(values["source-snapshot"], "utf8")) : undefined;
  if (snapshot && (!Array.isArray(snapshot.sources) || fingerprint(snapshot.sources) !== snapshot.sourceSnapshotHash)) throw new Error("Source snapshot digest differs");
  const manifest = parseSearchManifest({ schemaVersion: 2, buildId: values["build-id"],
    physicalIndex: `${values["base-index"]}_recall_v2_${values["build-id"]}`, analyzer: "standard", includeOcr: false,
    ...(snapshot ? { evaluationSourceSnapshotHash: snapshot.sourceSnapshotHash } : {}),
    chunker: { version: values.chunker, targetTokens: 256, maxTokens: values.chunker === "legacy-v1" ? 8192 : 512,
      overlapTokens: values.chunker === "legacy-v1" ? 0 : 32, maxChunks: 256 },
    embedding: { model: deployment.identity.model, revision: deployment.revision, dimensions: 1024,
      normalization: "l2", preprocessing: values.chunker === "legacy-v1" ? "trim-v1" : "nfc-whitespace-v1", maxInputTokens: deployment.identity.serving.maxModelLen,
      tokenizerSha256: descriptor.hashes["tokenizer.json"], tokenizerConfigSha256: descriptor.hashes["tokenizer_config.json"] } });
  await mkdir(values["tokenizer-dir"], { recursive: true });
  for (const [name, expected] of Object.entries(descriptor.hashes)) {
    if (deployment.identity.files.find((file) => file.name === name)?.sha256 !== expected) throw new Error("Tokenizer and deployed artifacts differ");
    const destination = join(values["tokenizer-dir"], name);
    let existing: Buffer | undefined;
    try { existing = await readFile(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) {
      if (createHash("sha256").update(existing).digest("hex") !== expected) throw new Error("Existing tokenizer checksum differs; select a new artifact directory");
      continue;
    }
    const temporary = `${destination}.${randomUUID()}.download`;
    try {
      // execFile passes arguments literally. curl honors the deployment's standard
      // proxy settings; no shell interpolation or model API credentials involved.
      await promisify(execFile)("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "90", "--output", temporary,
        `https://huggingface.co/${descriptor.model}/resolve/${descriptor.revision}/${name}`]);
      const bytes = await readFile(temporary);
      if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Downloaded tokenizer checksum differs");
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } finally { await rm(temporary, { force: true }); }
  }
  await loadSearchTokenizer(values["tokenizer-dir"], manifest.embedding);
  await writeFile(values.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ buildId: manifest.buildId, physicalIndex: manifest.physicalIndex, manifestHash: fingerprint(manifest),
    deploymentIdentityObservedAt: deployment.observedAt, localArtifactsVerified: true,
    note: "No DB/ES writes. Re-verify serving artifacts after model deployment changes; configure EMBEDDING_REVISION before provisioning." }));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message : "Recall build preparation failed; check artifact hashes and output paths.");
  process.exitCode = 1;
});
