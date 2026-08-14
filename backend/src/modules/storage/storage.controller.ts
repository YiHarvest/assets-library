import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiBadRequestResponse, ApiInternalServerErrorResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  StorageUsageRequestDto,
  StorageUsageResponseDto,
  ErrorResponseDto,
} from "../../contracts/dtos";
import { storageUsageSchema } from "../../contracts/schemas";
import { ApiService } from "../../services/api.service";

@ApiTags("storage")
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@Controller("storage")
export class StorageController {
  constructor(private readonly service: ApiService) {}

  @Post("usage")
  @HttpCode(200)
  @ApiOperation({ summary: "统计个人或公共长期素材空间" })
  @ApiOkResponse({ type: StorageUsageResponseDto })
  usage(
    @Body(new ZodValidationPipe(storageUsageSchema))
    body: StorageUsageRequestDto,
  ) {
    const input = storageUsageSchema.parse(body);
    return this.service.storageUsage(input.user_id);
  }
}
