import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { hashText } from "./fingerprint";
import { AppError } from "@/server/errors";
import type { SearchBuildManifest, TextTokenizer } from "./types";

export interface SearchTokenizer extends TextTokenizer { encode(text: string): number[] }

/** Only local, checksum-pinned artifacts; requests never download or silently change a tokenizer. */
export async function loadSearchTokenizer(directory: string, identity: SearchBuildManifest["embedding"]): Promise<SearchTokenizer> {
  const [json, config] = await Promise.all([
    readFile(path.join(directory, "tokenizer.json"), "utf8"),
    readFile(path.join(directory, "tokenizer_config.json"), "utf8"),
  ]);
  if (hashText(json) !== identity.tokenizerSha256 || hashText(config) !== identity.tokenizerConfigSha256) {
    throw new AppError("model_not_configured", "Tokenizer 文件指纹与索引构建不一致。", 503);
  }
  const tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
  return {
    count: (text) => tokenizer.encode(text, { add_special_tokens: true }).ids.length,
    encode: (text) => tokenizer.encode(text, { add_special_tokens: true }).ids,
  };
}
