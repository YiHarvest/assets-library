import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  PendingTaskListResponseDto,
  TaskResponseDto,
  ErrorResponseDto,
} from "../../contracts/dtos";
import { taskQuerySchema } from "../../contracts/schemas";
import { ApiService } from "../../services/api.service";

@ApiTags("tasks")
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@ApiExtraModels(TaskResponseDto, PendingTaskListResponseDto)
@Controller("tasks")
export class TasksController {
  constructor(private readonly service: ApiService) {}

  @Get()
  @ApiOperation({ summary: "查询单个任务或待入库任务批次" })
  @ApiQuery({ name: "task_id", required: false, format: "uuid" })
  @ApiQuery({ name: "view", required: false, enum: ["pending"] })
  @ApiQuery({ name: "user_id", required: false, type: String, nullable: true })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false, type: Number, example: 20 })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(TaskResponseDto) },
        { $ref: getSchemaPath(PendingTaskListResponseDto) },
      ],
    },
  })
  get(@Query(new ZodValidationPipe(taskQuerySchema)) query: unknown) {
    const input = taskQuerySchema.parse(query);
    return input.task_id
      ? this.service.getTask(input.task_id)
      : this.service.listPending(input.user_id, input.cursor, input.limit);
  }
}
