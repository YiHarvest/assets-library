import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly service: HealthService) {}
  @Get()
  @ApiOperation({ summary: "服务健康检查" })
  @ApiOkResponse({
    schema: {
      example: {
        status: "up",
        checked_at: "2026-08-14T10:00:00+08:00",
      },
    },
  })
  @ApiServiceUnavailableResponse({ description: "至少一个必需依赖不可用。" })
  async getHealth(@Res({ passthrough: true }) response: Response) {
    const result = await this.service.check();
    if (result.status !== "up") response.status(503);
    return result;
  }
}
