import { Global, Module } from "@nestjs/common";
import { ApiService } from "./api.service";
import { TemporaryUploadService } from "./temporary-upload.service";
import { TemporaryUploadIpRateLimitGuard, TemporaryUploadRateLimitService } from "./temporary-upload-rate-limit.service";

@Global()
@Module({
  providers: [ApiService, TemporaryUploadService, TemporaryUploadRateLimitService, TemporaryUploadIpRateLimitGuard],
  // Guard 由 controller 元数据在 AppModule 上下文中解析，因此同时导出其依赖。
  exports: [
    ApiService,
    TemporaryUploadService,
    TemporaryUploadRateLimitService,
    TemporaryUploadIpRateLimitGuard,
  ],
})
export class ServicesModule {}
