import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadSearchTokenizer } from "../src/server/search/v2/tokenizer";
import { buildSearchDocument } from "../src/server/search/v2/document";
import descriptor from "../config/recall/bge-m3-tokenizer.json";
import type { SearchBuildManifest } from "../src/server/search/v2/types";

async function main() {
  const base = process.env.EMBEDDING_BASE_URL?.replace(/\/$/, "");
  assert(base && process.env.EMBEDDING_MODEL, "Embedding service is required");
  const manifest: SearchBuildManifest = {
    schemaVersion: 2, buildId: "probe-only", physicalIndex: "probe_recall_v2_model", analyzer: "standard", includeOcr: false,
    chunker: { version: "visual-v2", targetTokens: 256, maxTokens: 512, overlapTokens: 32, maxChunks: 256 },
    embedding: { model: process.env.EMBEDDING_MODEL, revision: descriptor.revision, dimensions: 1024, normalization: "l2",
      preprocessing: "nfc-whitespace-v1", maxInputTokens: 8192, tokenizerSha256: descriptor.hashes["tokenizer.json"],
      tokenizerConfigSha256: descriptor.hashes["tokenizer_config.json"] },
  };
  const tokenizer = await loadSearchTokenizer(process.env.RECALL_TOKENIZER_DIR ?? "data/recall-tokenizers/bge-m3", manifest.embedding);
  const headers = { "content-type": "application/json", ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}) };
  const samples = ["海边没有人，2026年9月。", "没有红色汽车。\n两个人在海边喝咖啡。", "A woman is not running by the sea.",
    "👩🏽‍💻 café e\u0301 Ａ１２３", "<s>你好</s>", ""];
  const checks = [];
  let maxInputTokens: number | undefined;
  for (const prompt of samples) {
    const response: Response = await fetch(`${base.replace(/\/v1$/, "")}/tokenize`, { method: "POST", headers,
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, prompt, add_special_tokens: true }), signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Tokenize request: HTTP ${response.status}`);
    const result: { tokens: number[]; count: number; max_model_len: number } = await response.json();
    assert.deepEqual(tokenizer.encode(prompt), result.tokens, "Local tokenizer differs from serving tokenizer");
    assert.equal(result.count, tokenizer.count(prompt));
    maxInputTokens = result.max_model_len;
    checks.push({ characters: Array.from(prompt).length, tokens: result.count });
  }
  const started = performance.now();
  const description = Array.from({ length: 1_000 }, (_, i) => `场景${i}：海边没有红色汽车，人物正在行走。`).join("").slice(0, 10_000);
  const document = buildSearchDocument({ id: "capacity-probe", name: "Synthetic capacity probe", description,
    tags: [], analysis: null, segmentStartMs: null, segmentEndMs: null }, 1, manifest, tokenizer);
  assert(document.chunks.every((chunk) => chunk.tokenCount <= manifest.chunker.maxTokens));
  const covered = new Set<number>();
  for (const chunk of document.chunks) for (const ref of chunk.sourceRefs) {
    for (let i = ref.startChar!; i < ref.endChar!; i++) covered.add(i);
  }
  assert.equal(covered.size, Array.from(description).length, "Capacity input was truncated");
  const response = await fetch(`${base}/embeddings`, { method: "POST", headers,
    body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input: [samples[0]] }), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Embedding request: HTTP ${response.status}`);
  const data = await response.json();
  const vector: number[] = data.data[0].embedding;
  assert.equal(vector.length, 1024);
  assert(vector.every(Number.isFinite));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert(Math.abs(norm - 1) < 0.01, "Serving vector is not approximately L2-normalized");
  const report = { timestamp: new Date().toISOString(), tokenizer: descriptor, tokenizerParitySamples: checks,
    maxInputTokens, dimensions: vector.length, vectorNorm: norm,
    capacity: { characters: description.length, chunks: document.chunks.length,
      maximumTokens: Math.max(...document.chunks.map((chunk) => chunk.tokenCount)), elapsedMs: performance.now() - started },
    weightsRevisionVerified: false,
    limitations: "Tokenizer parity and output dimension do not prove deployed model weight identity. Verify deployment artifact before freezing a build.",
  };
  if (process.env.RECALL_MODEL_REPORT) await writeFile(process.env.RECALL_MODEL_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Recall model probe failed");
  process.exitCode = 1;
});
