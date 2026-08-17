import type { FailureCode } from "@/shared/contracts";
import { ZodError } from "zod";

const messages: Record<FailureCode, string> = {
  invalid_request: "上传请求无效，请重新选择文件。",
  multiple_files: "单次只能上传一个文件。",
  unsupported_media_type:
    "图片目标格式仅支持 JPEG、PNG、WebP，视频目标格式仅支持 MP4。",
  file_too_large: "文件超过对应类型的大小限制。",
  corrupt_file: "文件已损坏或无法读取，请更换文件。",
  unsupported_video_codec: "视频编码不受支持，且无法转换为 H.264。",
  invalid_video_frames: "视频关键帧无效或不完整，请重新选择视频上传。",
  model_not_configured: "模型服务尚未配置，请联系管理员。",
  model_video_unsupported:
    "当前模型协议未启用视频关键帧分析，请使用 Chat Completions 配置。",
  video_frames_missing: "视频关键帧不存在，请重新上传素材。",
  model_request_failed: "模型服务请求失败，请稍后重试。",
  model_response_invalid: "模型返回内容无法验证，请重试或更换模型。",
  storage_error: "文件保存失败，请重试。",
  internal_error: "系统处理失败，请稍后重试。",
};

export class AppError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string = messages[code],
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown) {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError(
            "invalid_request",
            error.issues[0]?.message ?? "请求字段无效。",
            400,
          )
      : new AppError("internal_error", undefined, 500);
  return Response.json(
    { error: { code: appError.code, message: appError.message } },
    { status: appError.status },
  );
}
