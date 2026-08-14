import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

export function temporaryUploadErrorPayload(exception: unknown) {
  const source = exception instanceof HttpException ? exception.getResponse() : undefined;
  const message =
    typeof source === "string"
      ? source
      : source && typeof source === "object" && "message" in source
        ? Array.isArray(source.message)
          ? String(source.message[0] ?? "临时文件无效。")
          : String(source.message)
        : "临时文件处理失败。";
  return { error: { code: "invalid_file", message } } as const;
}

@Catch()
export class TemporaryUploadExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    host.switchToHttp().getResponse<Response>().status(status).json(temporaryUploadErrorPayload(exception));
  }
}
