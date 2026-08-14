import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { errorLogDetails } from "./error-log";

function isPayloadTooLargeError(exception: unknown) {
  if (!exception || typeof exception !== "object") return false;
  const value = exception as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  return (
    value.status === HttpStatus.PAYLOAD_TOO_LARGE ||
    value.statusCode === HttpStatus.PAYLOAD_TOO_LARGE ||
    value.type === "entity.too.large"
  );
}

function codeForStatus(status: number) {
  if (status === HttpStatus.FORBIDDEN) return "forbidden";
  if (status === HttpStatus.NOT_FOUND) return "not_found";
  if (status === HttpStatus.CONFLICT) return "conflict";
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) return "file_too_large";
  if (status === HttpStatus.SERVICE_UNAVAILABLE) return "service_unavailable";
  if (status >= 500) return "internal_error";
  return "invalid_request";
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : isPayloadTooLargeError(exception)
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const source =
      exception instanceof HttpException ? exception.getResponse() : undefined;

    if (status >= 500) {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        kind: "unhandled_api_exception",
        error: errorLogDetails(exception),
      })}\n`);
    }

    if (
      source &&
      typeof source === "object" &&
      "error" in source &&
      typeof source.error === "object"
    ) {
      response.status(status).json(source);
      return;
    }

    const message =
      typeof source === "string"
        ? source
        : source && typeof source === "object" && "message" in source
          ? Array.isArray(source.message)
            ? String(source.message[0] ?? "请求字段无效。")
            : String(source.message)
          : status === HttpStatus.PAYLOAD_TOO_LARGE
            ? "请求体过大。"
            : status >= 500
              ? "系统处理失败，请稍后重试。"
              : "请求字段无效。";

    response.status(status).json({
      error: {
        code: codeForStatus(status),
        message,
      },
    });
  }
}
