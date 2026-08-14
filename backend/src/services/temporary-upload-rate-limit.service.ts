import { CanActivate, ExecutionContext, HttpException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { loadConfig } from "../config";
import { TemporaryUploadRateLimiter } from "./temporary-upload-rate-limiter";

@Injectable()
export class TemporaryUploadRateLimitService {
  private readonly config = loadConfig();
  private readonly limiter = new TemporaryUploadRateLimiter(
    this.config.TEMP_UPLOAD_IP_REQUESTS_PER_MINUTE,
    this.config.TEMP_UPLOAD_USER_REQUESTS_PER_MINUTE,
  );

  consumeIp(ip: string) {
    try {
      this.limiter.consumeIp(ip);
    } catch {
      throw new HttpException("临时上传来源IP请求速率超过限制。", 429);
    }
  }

  consumeUser(userHash: string) {
    try {
      this.limiter.consumeUser(userHash);
    } catch {
      throw new HttpException("临时上传用户请求速率超过限制。", 429);
    }
  }
}

@Injectable()
export class TemporaryUploadIpRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: TemporaryUploadRateLimitService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    // Guard在FilesInterceptor之前执行，超限请求不会进入Multer或写临时磁盘。
    this.rateLimit.consumeIp(request.ip || request.socket.remoteAddress || "unknown");
    return true;
  }
}
