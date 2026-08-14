import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  CompleteUploadRequestDto,
  CreateUploadRequestDto,
  CreateUploadResponseDto,
  TaskResponseDto,
  ErrorResponseDto,
} from "../../contracts/dtos";
import {
  completeUploadSchema,
  createUploadSchema,
} from "../../contracts/schemas";
import { ApiService } from "../../services/api.service";

@ApiTags("uploads")
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@Controller("uploads")
export class UploadsController {
  constructor(private readonly service: ApiService) {}

  @Post()
  @ApiOperation({ summary: "创建永久上传任务并获取预签名 PUT URL" })
  @ApiCreatedResponse({ type: CreateUploadResponseDto })
  create(
    @Body(new ZodValidationPipe(createUploadSchema))
    body: CreateUploadRequestDto,
  ) {
    return this.service.createUpload(createUploadSchema.parse(body));
  }

  @Post("complete")
  @HttpCode(202)
  @ApiOperation({ summary: "通知后端前端直传已完成" })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  complete(
    @Body(new ZodValidationPipe(completeUploadSchema))
    body: CompleteUploadRequestDto,
  ) {
    return this.service.completeUpload(body.task_id);
  }
}
