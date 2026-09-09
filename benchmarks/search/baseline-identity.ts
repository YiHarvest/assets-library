import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fingerprint } from "../../src/server/search/v2/fingerprint";

/** Conservative identity of current v1 implementation and configuration resolver.
 * Even an unrelated edit in these files requires a new explicit baseline receipt. */
export async function baselineImplementationHash() {
  const files = ["../../src/server/search/elasticsearch.ts", "../../src/server/config.ts"];
  const hashes = await Promise.all(files.map(async (file) => [file, createHash("sha256")
    .update(await readFile(new URL(file, import.meta.url))).digest("hex")]));
  return fingerprint(hashes);
}
