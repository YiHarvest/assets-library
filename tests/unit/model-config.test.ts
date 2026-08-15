import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";

describe("model configuration", () => {
  it("uses bounded video requests and per-target concurrency by default", () => {
    const config = loadConfig({});

    expect(config.VLM_VIDEO_TIMEOUT_MS).toBe(120_000);
    expect(config.VLM_MAX_OUTPUT_TOKENS).toBe(1_280);
    expect(config.VLM_PRIMARY_BUDGET_MS).toBe(60_000);
    expect(config.VLM_TOTAL_BUDGET_MS).toBe(90_000);
    expect(config.VLM_FAST_RETRY_WINDOW_MS).toBe(5_000);
    expect(config.VLM_RETRY_COUNT).toBe(1);
    expect(config.VLM_MAX_CONCURRENCY_PER_TARGET).toBe(2);
  });

  it("rejects a primary model budget larger than the full candidate budget", () => {
    expect(() =>
      loadConfig({
        VLM_PRIMARY_BUDGET_MS: "90001",
        VLM_TOTAL_BUDGET_MS: "90000",
      }),
    ).toThrow(/主模型预算/);
  });

  it("builds the VLM target from the current settings", () => {
    const config = loadConfig({
      VLM_PROTOCOL: "openai_chat_completions",
      VLM_BASE_URL: "https://models.example/v1/",
      VLM_API_KEY: "vision-key",
      VLM_NAME: "qwen3.7-plus",
      VLM_ENABLE_THINKING: "false",
    });

    expect(config.models.vlm).toEqual({
      role: "vlm",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example/v1",
      apiKey: "vision-key",
      name: "qwen3.7-plus",
      configured: true,
      requestOptions: { enableThinking: false },
    });
    expect(config.models.llm).toMatchObject({
      role: "llm",
      configured: false,
      name: undefined,
      requestOptions: { enableThinking: null },
    });
    expect(config.models.vlmCandidates).toHaveLength(1);
    expect(config.models.llmCandidates).toEqual([]);
  });

  it("parses ordered VLM candidates and removes exact duplicates", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://models.example/v1",
      VLM_NAME: "qwen3.7-plus",
      VLM_FALLBACK_NAMES:
        " kimi-k2.5, qwen3.7-plus, ,Qwythos,kimi-k2.5,qwythos ",
      VLM_ENABLE_THINKING: "false",
    });

    expect(config.models.vlmCandidates.map((model) => model.name)).toEqual([
      "qwen3.7-plus",
      "kimi-k2.5",
      "Qwythos",
      "qwythos",
    ]);
    expect(
      config.models.vlmCandidates.map(
        (model) => model.requestOptions.enableThinking,
      ),
    ).toEqual([false, false, false, false]);
  });

  it("builds LLM candidates with the inherited endpoint and explicit thinking", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://models.example/v1",
      VLM_API_KEY: "shared-key",
      VLM_NAME: "qwen3.7-plus",
      LLM_NAME: "Qwythos",
      LLM_FALLBACK_NAMES: "kimi-k2.5",
      LLM_ENABLE_THINKING: "false",
    });

    expect(config.models.llmCandidates).toEqual([
      expect.objectContaining({
        name: "Qwythos",
        baseUrl: "https://models.example/v1",
        apiKey: "shared-key",
        requestOptions: { enableThinking: false },
      }),
      expect.objectContaining({
        name: "kimi-k2.5",
        baseUrl: "https://models.example/v1",
        apiKey: "shared-key",
        requestOptions: { enableThinking: false },
      }),
    ]);
  });

  it("applies model-family thinking defaults to each candidate", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://models.example/v1",
      VLM_NAME: "vision-model",
      VLM_FALLBACK_NAMES: "qwen3.7-plus",
    });

    expect(
      config.models.vlmCandidates.map((model) => ({
        name: model.name,
        enableThinking: model.requestOptions.enableThinking,
      })),
    ).toEqual([
      { name: "vision-model", enableThinking: null },
      { name: "qwen3.7-plus", enableThinking: false },
    ]);
  });

  it("rejects fallback-only and oversized candidate configurations", () => {
    expect(() =>
      loadConfig({
        VLM_BASE_URL: "https://models.example/v1",
        VLM_FALLBACK_NAMES: "kimi-k2.5",
      }),
    ).toThrow(/VLM_NAME/);
    expect(() =>
      loadConfig({
        VLM_BASE_URL: "https://models.example/v1",
        VLM_NAME: "model-1",
        VLM_FALLBACK_NAMES:
          "model-2,model-3,model-4,model-5,model-6",
      }),
    ).toThrow(/at most 5/);
  });

  it("keeps VLM and LLM targets independent", () => {
    const config = loadConfig({
      VLM_PROTOCOL: "openai_chat_completions",
      VLM_BASE_URL: "https://vision.example/v1",
      VLM_API_KEY: "vision-key",
      VLM_NAME: "qwen3.7-plus",
      VLM_ENABLE_THINKING: "false",
      LLM_PROTOCOL: "openai_responses",
      LLM_BASE_URL: "https://text.example/v1/",
      LLM_API_KEY: "text-key",
      LLM_NAME: "Qwythos",
      LLM_ENABLE_THINKING: "true",
    });

    expect(config.models.vlm).toMatchObject({
      role: "vlm",
      protocol: "openai_chat_completions",
      baseUrl: "https://vision.example/v1",
      apiKey: "vision-key",
      name: "qwen3.7-plus",
      configured: true,
      requestOptions: { enableThinking: false },
    });
    expect(config.models.llm).toMatchObject({
      role: "llm",
      protocol: "openai_responses",
      baseUrl: "https://text.example/v1",
      apiKey: "text-key",
      name: "Qwythos",
      configured: true,
      requestOptions: { enableThinking: true },
    });
  });

  it("allows an authentication-free OpenAI-compatible VLM endpoint", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://vision.example/v1",
      VLM_NAME: "vision-model",
    });

    expect(config.models.vlm.configured).toBe(true);
    expect(config.models.vlm.apiKey).toBeUndefined();
  });

  it("treats an empty thinking option as unsupported instead of false", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://models.example/v1",
      VLM_API_KEY: "shared-key",
      VLM_NAME: "vision-model",
      LLM_BASE_URL: "https://text.example/v1",
      LLM_API_KEY: "",
      LLM_NAME: "Qwythos",
      LLM_ENABLE_THINKING: "",
    });

    expect(config.models.llm.requestOptions.enableThinking).toBeNull();
    expect(config.models.llm.apiKey).toBe("shared-key");
  });

  it("applies model-family thinking defaults unless explicitly overridden", () => {
    const config = loadConfig({
      VLM_BASE_URL: "https://vision.example/v1",
      VLM_NAME: "qwen3.7-plus",
      LLM_BASE_URL: "https://text.example/v1",
      LLM_NAME: "qwen3.7-plus",
      LLM_ENABLE_THINKING: "true",
    });

    expect(config.models.vlm.requestOptions.enableThinking).toBe(false);
    expect(config.models.llm.requestOptions.enableThinking).toBe(true);
  });

  it("uses the first configured model target as the embedding fallback", () => {
    const llmOnly = loadConfig({
      LLM_BASE_URL: "https://text.example/v1",
      LLM_API_KEY: "text-key",
      LLM_NAME: "text-model",
      EMBEDDING_MODEL: "embedding-model",
    });
    const bothTargets = loadConfig({
      VLM_BASE_URL: "https://vision.example/v1",
      VLM_API_KEY: "vision-key",
      VLM_NAME: "vision-model",
      LLM_BASE_URL: "https://text.example/v1",
      LLM_API_KEY: "text-key",
      LLM_NAME: "text-model",
      EMBEDDING_MODEL: "embedding-model",
    });

    expect(llmOnly.embeddingBaseUrl).toBe("https://text.example/v1");
    expect(llmOnly.embeddingApiKey).toBe("text-key");
    expect(llmOnly.embeddingConfigured).toBe(true);
    expect(bothTargets.embeddingBaseUrl).toBe("https://vision.example/v1");
    expect(bothTargets.embeddingApiKey).toBe("vision-key");
  });
});
