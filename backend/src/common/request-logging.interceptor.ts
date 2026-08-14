import { randomUUID } from "node:crypto";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { HttpException, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { catchError, finalize } from "rxjs/operators";
import { throwError } from "rxjs";
import { loadConfig } from "../config";

function emit(level: "info" | "warn", entry: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, ...entry })}\n`);
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly config = loadConfig();

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const supplied = request.header("x-operation-id")?.trim();
    const operationId = supplied && supplied.length <= 128 ? supplied : randomUUID();
    response.setHeader("x-operation-id", operationId);
    const started = performance.now();
    emit("info", {
      kind: "request_started",
      operation_id: operationId,
      method: request.method,
      path: request.originalUrl.split("?", 1)[0],
    });
    let failureStatus: number | undefined;
    return next.handle().pipe(
      catchError((error: unknown) => {
        failureStatus = error instanceof HttpException ? error.getStatus() : 500;
        return throwError(() => error);
      }),
      finalize(() => {
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      emit(durationMs >= this.config.SLOW_OPERATION_MS ? "warn" : "info", {
        kind: failureStatus ? "request_failed" : "request_completed",
        operation_id: operationId,
        method: request.method,
        // originalUrl 不记录 query，避免泄露预签名 URL 或用户查询内容。
        path: request.originalUrl.split("?", 1)[0],
        status: failureStatus ?? response.statusCode,
        duration_ms: durationMs,
        slow_operation: durationMs >= this.config.SLOW_OPERATION_MS,
        remote_address: request.ip,
      });
    }));
  }
}
