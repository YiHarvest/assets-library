import { AppError } from "@/server/errors";
import { fingerprint } from "./fingerprint";
import { parseSearchManifest, searchIndexDefinition } from "./manifest";
import type { EmbeddedSearchDocument, SearchBuildManifest } from "./types";
import type { SearchDocumentStore } from "./writer";

export interface ElasticsearchOptions { url: string; username?: string; password?: string; timeoutMs: number }

export class ElasticsearchClient {
  constructor(private readonly options: ElasticsearchOptions) {}

  async request(path: string, init: RequestInit = {}, allowedStatuses: number[] = []) {
    let response: Response;
    try {
      response = await fetch(`${this.options.url.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers,
          ...(this.options.username ? { authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password ?? ""}`).toString("base64")}` } : {}) },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch { throw new AppError("storage_error", "Elasticsearch 服务连接失败或请求超时。", 503); }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new AppError("storage_error", `Elasticsearch 请求失败：HTTP ${response.status}。`, 502);
    }
    return response;
  }
}

export async function readSearchManifest(client: ElasticsearchClient, physicalIndex: string) {
  const response = await client.request(`/${encodeURIComponent(physicalIndex)}/_mapping`);
  return parseSearchIndexMetadata(await response.json(), physicalIndex);
}

export function parseSearchIndexMetadata(
  mappings: Record<string, { mappings?: ReturnType<typeof searchIndexDefinition>["mappings"] }>, physicalIndex: string,
) {
  const mapping = mappings[physicalIndex]?.mappings;
  const saved = mapping?._meta?.recall;
  const manifest = parseSearchManifest(saved?.manifest);
  if (!mapping || !saved || Object.keys(mappings).length !== 1 || manifest.physicalIndex !== physicalIndex || saved.manifestHash !== fingerprint(manifest) ||
    mapping.dynamic !== "strict" || mapping.properties?.chunks?.type !== "nested" ||
    mapping.properties.chunks.properties?.embedding?.dims !== manifest.embedding.dimensions ||
    mapping.properties.chunks.properties.embedding.similarity !== "cosine") {
    throw new AppError("storage_error", "索引 mapping 与固定构建清单不一致。", 503);
  }
  return manifest;
}

/** Provisioning only. Neither the writer nor a query is allowed to create an index. */
export async function createSearchIndex(client: ElasticsearchClient, manifest: SearchBuildManifest) {
  parseSearchManifest(manifest);
  const response = await client.request(`/${encodeURIComponent(manifest.physicalIndex)}`, {
    method: "PUT", body: JSON.stringify(searchIndexDefinition(manifest)),
  }, [400]);
  if (!response.ok) {
    const failure = await response.json();
    if (failure.error?.type !== "resource_already_exists_exception") throw new AppError("storage_error", "无法创建召回构建索引。", 502);
  }
  const existing = await readSearchManifest(client, manifest.physicalIndex);
  if (fingerprint(existing) !== fingerprint(manifest)) throw new AppError("storage_error", "现有索引属于不同的召回构建。", 503);
}

export function searchDocumentStore(client: ElasticsearchClient, manifest: SearchBuildManifest): SearchDocumentStore {
  const index = encodeURIComponent(manifest.physicalIndex);
  return {
    async read(assetId) {
      const response = await client.request(`/${index}/_doc/${encodeURIComponent(assetId)}`, {}, [404]);
      const result = await response.json();
      if (response.status === 404) {
        // Missing documents are normal; a missing index is a broken deployment.
        if (result.error) throw new AppError("storage_error", "目标召回构建索引不存在。", 503);
        return null;
      }
      return { version: result._version as number, document: result._source as EmbeddedSearchDocument };
    },
    async replace(document) {
      const response = await client.request(`/${index}/_doc/${encodeURIComponent(document.assetId)}?version=${document.sourceRevision}&version_type=external&refresh=wait_for`, {
        method: "PUT", body: JSON.stringify(document),
      }, [409]);
      if (response.status === 409) return "conflict";
      const result = await response.json();
      if (result._shards?.failed) throw new AppError("storage_error", "召回文档写入分片失败。", 503);
      return "written";
    },
  };
}
