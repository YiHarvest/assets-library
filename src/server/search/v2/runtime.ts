import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import { fingerprint } from "./fingerprint";
import { ElasticsearchClient, readSearchManifest, searchDocumentStore } from "./elasticsearch";
import { SearchEmbeddingClient } from "./embedding";
import { loadSearchTokenizer } from "./tokenizer";
import type { SearchTokenizer } from "./tokenizer";
import type { SearchBuildManifest } from "./types";
import type { EmbedSearchTexts, SearchDocumentStore } from "./writer";

export interface SearchBuildRuntime { tokenizer: SearchTokenizer; embed: EmbedSearchTexts; store: SearchDocumentStore; client: ElasticsearchClient }
const builds = new Map<string, Promise<SearchBuildRuntime>>();
const tokenizers = new Map<string, Promise<SearchTokenizer>>();
const embedders = new Map<string, SearchEmbeddingClient>();

/** Config is checked on each acquisition; caches never allow an identity mismatch. */
export async function loadSearchBuildRuntime(manifest: SearchBuildManifest): Promise<SearchBuildRuntime> {
  const config = loadConfig();
  if (!config.embeddingBaseUrl || !config.ELASTICSEARCH_URL || config.EMBEDDING_MODEL !== manifest.embedding.model ||
    config.EMBEDDING_REVISION !== manifest.embedding.revision) {
    throw new AppError("model_not_configured", "Embedding 部署修订号或服务配置与召回构建不一致。", 503);
  }
  const options = { baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey, model: manifest.embedding.model,
    dimensions: manifest.embedding.dimensions, maxInputTokens: manifest.embedding.maxInputTokens,
    maxBatchTexts: config.SEARCH_V2_EMBED_BATCH_TEXTS, maxBatchTokens: config.SEARCH_V2_EMBED_BATCH_TOKENS,
    concurrency: config.SEARCH_V2_EMBED_CONCURRENCY, timeoutMs: config.SEARCH_V2_EMBED_TIMEOUT_MS };
  const key = fingerprint({ manifest, options, es: config.ELASTICSEARCH_URL, esUser: config.ELASTICSEARCH_USERNAME,
    esPassword: config.ELASTICSEARCH_PASSWORD, tokenizer: config.SEARCH_V2_TOKENIZER_DIR });
  let pending = builds.get(key);
  if (!pending) {
    pending = (async () => {
      const client = new ElasticsearchClient({ url: config.ELASTICSEARCH_URL!, username: config.ELASTICSEARCH_USERNAME,
        password: config.ELASTICSEARCH_PASSWORD, timeoutMs: config.SEARCH_TIMEOUT_MS });
      if (fingerprint(await readSearchManifest(client, manifest.physicalIndex)) !== fingerprint(manifest)) {
        throw new AppError("storage_error", "召回物理索引与作业构建不一致。", 503);
      }
      const tokenizerKey = fingerprint({ directory: config.SEARCH_V2_TOKENIZER_DIR, tokenizer: manifest.embedding.tokenizerSha256,
        config: manifest.embedding.tokenizerConfigSha256 });
      let tokenizer = tokenizers.get(tokenizerKey);
      if (!tokenizer) {
        tokenizer = loadSearchTokenizer(config.SEARCH_V2_TOKENIZER_DIR, manifest.embedding);
        tokenizers.set(tokenizerKey, tokenizer);
        void tokenizer.catch(() => { tokenizers.delete(tokenizerKey); });
      }
      const embedKey = fingerprint({ options, identity: manifest.embedding });
      let embedder = embedders.get(embedKey);
      if (!embedder) { embedder = new SearchEmbeddingClient(options); embedders.set(embedKey, embedder); }
      return { tokenizer: await tokenizer, embed: embedder.embed, store: searchDocumentStore(client, manifest), client };
    })();
    builds.set(key, pending);
    void pending.catch(() => { builds.delete(key); });
  }
  return pending;
}
