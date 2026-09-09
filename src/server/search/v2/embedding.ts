import { AppError } from "@/server/errors";
import { validVector } from "./writer";
import type { EmbedSearchTexts } from "./writer";

export interface SearchEmbeddingOptions {
  baseUrl: string; apiKey?: string; model: string; dimensions: number; maxInputTokens: number;
  maxBatchTexts: number; maxBatchTokens: number; concurrency: number; timeoutMs: number;
}

/** One instance per process/model. Concurrent queries and indexing share its request permits. */
export class SearchEmbeddingClient {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: SearchEmbeddingOptions) {
    if ([options.dimensions, options.maxInputTokens, options.maxBatchTexts, options.maxBatchTokens, options.concurrency, options.timeoutMs]
      .some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new AppError("model_not_configured", "Embedding 并发或批量预算配置无效。", 503);
    }
  }

  private async acquire(signal: AbortSignal) {
    if (signal.aborted) throw new AppError("model_request_failed", "Embedding 请求等待超时。", 503);
    if (this.active < this.options.concurrency) { this.active++; return; }
    if (this.waiters.length >= 128) throw new AppError("model_request_failed", "Embedding 请求队列已满。", 503);
    await new Promise<void>((resolve, reject) => {
      const enter = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== enter);
        reject(new AppError("model_request_failed", "Embedding 请求等待超时。", 503));
      };
      this.waiters.push(enter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private async request(texts: string[]) {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    await this.acquire(signal);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST", headers: { "content-type": "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.options.model, input: texts }), signal,
        });
      } catch { throw new AppError("model_request_failed", "Embedding 服务连接失败或请求超时。", 503); }
      if (!response.ok) throw new AppError("model_request_failed", `Embedding 服务返回 HTTP ${response.status}。`, 502);
      const result = await response.json().catch(() => null);
      const entries: Array<{ index: number; embedding: unknown }> | undefined = result?.data;
      if (!Array.isArray(entries) || entries.length !== texts.length ||
        new Set(entries.map((entry) => entry?.index)).size !== texts.length ||
        entries.some((entry) => !Number.isInteger(entry?.index) || entry.index < 0 || entry.index >= texts.length)) {
        throw new AppError("model_response_invalid", "Embedding 返回的输入索引不完整或重复。", 502);
      }
      return [...entries].sort((a, b) => a.index - b.index).map((entry) => {
        if (!validVector(entry.embedding, this.options.dimensions)) throw new AppError("model_response_invalid", "Embedding 向量维度或数值无效。", 502);
        const norm = Math.hypot(...entry.embedding);
        if (!Number.isFinite(norm) || norm === 0) throw new AppError("model_response_invalid", "Embedding 向量范数无效。", 502);
        return entry.embedding.map((value) => value / norm);
      });
    } finally { this.release(); }
  }

  readonly embed: EmbedSearchTexts = async (texts) => {
    const batches: string[][] = [];
    let current: string[] = [];
    let tokens = 0;
    for (const item of texts) {
      if (!Number.isSafeInteger(item.tokenCount) || item.tokenCount < 1 ||
        item.tokenCount > Math.min(this.options.maxInputTokens, this.options.maxBatchTokens)) {
        throw new AppError("invalid_request", "Embedding 输入超过 token 预算。", 422);
      }
      if (current.length && (current.length >= this.options.maxBatchTexts || tokens + item.tokenCount > this.options.maxBatchTokens)) {
        batches.push(current); current = []; tokens = 0;
      }
      current.push(item.text); tokens += item.tokenCount;
    }
    if (current.length) batches.push(current);
    return (await Promise.all(batches.map((batch) => this.request(batch)))).flat();
  };
}
