import { loadConfig } from "../config";
import { analysisSchema, type AnalysisResult } from "./analysis.types";

export interface AnalysisInput {
  mediaType: "image" | "video";
  mimeType: string;
  images: Array<{ bytes: Buffer; timestampSeconds?: number }>;
}

function stripFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function extractText(payload: unknown, protocol: "openai_chat_completions" | "openai_responses") {
  if (protocol === "openai_responses") {
    const result = payload as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    return result.output_text ?? result.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
  }
  const result = payload as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const content = result.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : content?.map((item) => item.text ?? "").join("") ?? "";
}

function prompt(mediaType: "image" | "video", correction?: string) {
  const shape = mediaType === "image"
    ? `{ "kind":"image", "description":"", "tags":{"场景":["中文标签"]}, "ocr":{"text":null,"unavailable_reason":null} }`
    : `{ "kind":"video", "description":"", "topics":["中文主题"], "tags":{"场景":["中文标签"]}, "visual_segments":[{"start_seconds":0,"end_seconds":1,"summary":""}], "key_moments":[{"seconds":0,"summary":""}], "timeline":[{"start_seconds":0,"end_seconds":1,"summary":""}] }`;
  return [
    "你是素材库的多模态分析器。描述、主题、标签和摘要使用简体中文。",
    mediaType === "image"
      ? "识别画面及所有可见 OCR 文字。存在文字时，ocr.text 按阅读顺序完整抄录、保留换行，ocr.unavailable_reason 必须为 null；没有可识别文字时，ocr.text 必须为 null，ocr.unavailable_reason 必须填写‘无可识别文本’。"
      : "图片按时间顺序采样自同一视频，只分析画面并生成视觉分段、关键时间点和时间轴。",
    `只输出符合以下结构的 JSON，不要 Markdown：${shape}`,
    correction ? `上一次结果无效：${correction}` : "",
  ].filter(Boolean).join("\n");
}

export class Analyzer {
  private readonly config = loadConfig();
  private static readonly cooldownUntil = new Map<string, number>();

  async analyze(input: AnalysisInput, signal?: AbortSignal): Promise<{ result: AnalysisResult; protocol: string; model: string }> {
    const names = [this.config.VLM_NAME, ...(this.config.VLM_FALLBACK_NAMES?.split(",") ?? [])]
      .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
    if (!this.config.VLM_BASE_URL || names.length === 0) throw new Error("VLM 未配置。");
    let lastError: unknown;
    const uniqueNames = [...new Set(names)];
    const available = uniqueNames.filter((model) => (Analyzer.cooldownUntil.get(model) ?? 0) <= Date.now());
    for (const model of available.length ? available : uniqueNames) {
      for (let attempt = 0; attempt <= this.config.VLM_RETRY_COUNT; attempt += 1) {
        try {
          const result = await this.request(model, input, attempt ? String(lastError) : undefined, signal);
          Analyzer.cooldownUntil.delete(model);
          return { result, protocol: this.config.VLM_PROTOCOL, model };
        } catch (error) {
          lastError = error;
          if (error instanceof ModelResponseError && [401, 403].includes(error.status)) throw error;
          if (error instanceof ModelResponseError && [404, 429].includes(error.status)) {
            Analyzer.cooldownUntil.set(model, Date.now() + this.config.VLM_FAILOVER_COOLDOWN_MS);
            break;
          }
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("VLM 分析失败。");
  }

  private async request(model: string, input: AnalysisInput, correction?: string, externalSignal?: AbortSignal) {
    const imageContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const [index, image] of input.images.entries()) {
      if (image.timestampSeconds !== undefined) imageContent.push({ type: "text", text: `关键帧 ${index + 1}：${image.timestampSeconds} 秒` });
      imageContent.push({ type: "image_url", image_url: { url: `data:${input.mediaType === "image" ? input.mimeType : "image/jpeg"};base64,${image.bytes.toString("base64")}` } });
    }
    const timeoutSignal = AbortSignal.timeout(input.mediaType === "video" ? this.config.VLM_VIDEO_TIMEOUT_MS : this.config.VLM_TIMEOUT_MS);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
    const endpoint = this.config.VLM_PROTOCOL === "openai_responses" ? "/responses" : "/chat/completions";
    const responseContent = imageContent.map((part) =>
      part.type === "image_url"
        ? { type: "input_image", image_url: part.image_url.url }
        : { type: "input_text", text: part.text },
    );
    const body = this.config.VLM_PROTOCOL === "openai_responses"
      ? {
          model,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: prompt(input.mediaType, correction) },
              ...responseContent,
            ],
          }],
        }
      : {
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt(input.mediaType, correction) },
              ...imageContent,
            ],
          }],
          temperature: 0,
          ...(this.config.VLM_ENABLE_THINKING ? { enable_thinking: true } : {}),
        };
    const response = await fetch(`${this.config.VLM_BASE_URL!.replace(/\/$/, "")}${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", ...(this.config.VLM_API_KEY ? { authorization: `Bearer ${this.config.VLM_API_KEY}` } : {}) },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw new ModelResponseError(response.status, `VLM ${model} 返回 HTTP ${response.status}。`);
    const text = extractText(await response.json(), this.config.VLM_PROTOCOL);
    if (!text) throw new Error("VLM 没有返回文本。");
    return analysisSchema.parse(JSON.parse(stripFence(text)));
  }
}

class ModelResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ModelResponseError";
  }
}
