import { Body, Controller, HttpCode, HttpException, Post } from "@nestjs/common";
import { ApiBody, ApiExtraModels, ApiNoContentResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, ApiTooManyRequestsResponse, getSchemaPath } from "@nestjs/swagger";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadConfig } from "../../config";

class ObservabilityMetadataDto {
  @ApiPropertyOptional() declare action?: string;
  @ApiPropertyOptional() declare endpoint?: string;
  @ApiPropertyOptional() declare method?: string;
  @ApiPropertyOptional() declare status_code?: number;
  @ApiPropertyOptional() declare status?: string;
  @ApiPropertyOptional() declare phase?: string;
  @ApiPropertyOptional() declare previous_status?: string;
  @ApiPropertyOptional() declare previous_phase?: string;
  @ApiPropertyOptional() declare task_type?: string;
  @ApiPropertyOptional() declare task_id?: string;
  @ApiPropertyOptional() declare file_id?: string;
  @ApiPropertyOptional() declare video_source_id?: string;
  @ApiPropertyOptional() declare file_count?: number;
  @ApiPropertyOptional() declare file_position?: number;
  @ApiPropertyOptional() declare media_type?: string;
  @ApiPropertyOptional() declare auto_publish?: boolean;
  @ApiPropertyOptional() declare user_scope?: string;
  @ApiPropertyOptional() declare view?: string;
  @ApiPropertyOptional() declare progress_percent?: number;
  @ApiPropertyOptional() declare error_type?: string;
}

class ObservabilityEventDto {
  @ApiProperty({ maxLength: 128 }) declare operation_id: string;
  @ApiProperty({ maxLength: 128 }) declare event: string;
  @ApiProperty({ maxLength: 128 }) declare step: string;
  @ApiProperty({ minimum: 0, maximum: 86_400_000 }) declare duration_ms: number;
  @ApiProperty({ enum: ["started", "done", "failed"] }) declare status: "started" | "done" | "failed";
  @ApiPropertyOptional({ type: () => ObservabilityMetadataDto }) declare metadata?: ObservabilityMetadataDto;
}

const metadataValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const metadataSchema = z.object({
  action: metadataValue.optional(), endpoint: metadataValue.optional(), method: metadataValue.optional(),
  status_code: metadataValue.optional(), status: metadataValue.optional(), phase: metadataValue.optional(),
  previous_status: metadataValue.optional(), previous_phase: metadataValue.optional(), task_type: metadataValue.optional(),
  task_id: metadataValue.optional(), file_id: metadataValue.optional(), video_source_id: metadataValue.optional(),
  file_count: metadataValue.optional(), file_position: metadataValue.optional(), media_type: metadataValue.optional(),
  auto_publish: metadataValue.optional(), user_scope: metadataValue.optional(), view: metadataValue.optional(),
  progress_percent: metadataValue.optional(), error_type: metadataValue.optional(),
}).strict();

export const eventSchema = z.object({
  operation_id: z.string().trim().min(1).max(128),
  event: z.string().trim().min(1).max(128),
  step: z.string().trim().min(1).max(128),
  duration_ms: z.number().finite().nonnegative().max(86_400_000),
  status: z.enum(["started", "done", "failed"]),
  metadata: metadataSchema.optional(),
}).strict();

@ApiTags("observability")
@ApiExtraModels(ObservabilityEventDto, ObservabilityMetadataDto)
@Controller("observability")
export class ObservabilityController {
  private readonly config = loadConfig();
  private windowStartedAt = Date.now();
  private eventsInWindow = 0;

  @Post("events")
  @HttpCode(204)
  @ApiOperation({ summary: "记录前端操作步骤与耗时", description: "内部运维接口，仅写结构化运行日志，不写业务状态。" })
  @ApiBody({ schema: {
    allOf: [
      { $ref: getSchemaPath(ObservabilityEventDto) },
      { additionalProperties: false, properties: {
        metadata: { allOf: [{ $ref: getSchemaPath(ObservabilityMetadataDto) }], additionalProperties: false },
      } },
    ],
  } })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({ description: "进程级观测事件速率超过限制。" })
  event(@Body(new ZodValidationPipe(eventSchema)) body: z.infer<typeof eventSchema>) {
    const now = Date.now();
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.eventsInWindow = 0;
    }
    if (this.eventsInWindow >= this.config.OBSERVABILITY_EVENTS_PER_MINUTE) {
      throw new HttpException("观测事件速率超过限制。", 429);
    }
    this.eventsInWindow += 1;
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: body.status === "failed" || body.duration_ms >= this.config.SLOW_OPERATION_MS ? "warn" : "info",
      kind: "frontend_event",
      slow_operation: body.duration_ms >= this.config.SLOW_OPERATION_MS,
      ...body,
    })}\n`);
  }
}
