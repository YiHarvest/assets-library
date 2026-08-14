import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Query } from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  AssetDetailDto,
  AssetListRequestDto,
  AssetListResponseDto,
  AssetSearchRequestDto,
  DeleteAssetRequestDto,
  ImageAnalysisDto,
  PublishAssetRequestDto,
  RetryAssetRequestDto,
  TaskResponseDto,
  UpdateAssetRequestDto,
  VideoAnalysisDto,
  ErrorResponseDto,
} from "../../contracts/dtos";
import {
  assetDetailQuerySchema,
  assetListSchema,
  assetSearchSchema,
  deleteAssetSchema,
  publishAssetSchema,
  retryAssetSchema,
  updateAssetSchema,
} from "../../contracts/schemas";
import { ApiService } from "../../services/api.service";

@ApiTags("assets")
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: "ZOS临时对象状态暂时无法确认。" })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@ApiExtraModels(ImageAnalysisDto, VideoAnalysisDto)
@Controller("assets")
export class AssetsController {
  constructor(private readonly service: ApiService) {}

  @Post("list")
  @HttpCode(200)
  @ApiOperation({ summary: "分页列出素材" })
  @ApiOkResponse({ type: AssetListResponseDto })
  list(
    @Body(new ZodValidationPipe(assetListSchema)) body: AssetListRequestDto,
  ) {
    return this.service.listAssets(assetListSchema.parse(body));
  }

  @Post("search")
  @HttpCode(200)
  @ApiOperation({ summary: "搜索已入库素材" })
  @ApiOkResponse({ type: AssetListResponseDto })
  search(
    @Body(new ZodValidationPipe(assetSearchSchema)) body: AssetSearchRequestDto,
  ) {
    return this.service.searchAssets(assetSearchSchema.parse(body));
  }

  @Get("detail")
  @ApiOperation({ summary: "获取已入库素材详情" })
  @ApiQuery({ name: "file_id", format: "uuid" })
  @ApiOkResponse({ type: AssetDetailDto })
  detail(
    @Query(new ZodValidationPipe(assetDetailQuerySchema)) query: unknown,
  ) {
    return this.service.assetDetail(assetDetailQuerySchema.parse(query).file_id);
  }

  @Patch("update")
  @HttpCode(202)
  @ApiOperation({ summary: "增量编辑个人素材信息" })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  update(
    @Body(new ZodValidationPipe(updateAssetSchema)) body: UpdateAssetRequestDto,
  ) {
    return this.service.queueMutation("update", updateAssetSchema.parse(body));
  }

  @Post("publish")
  @HttpCode(202)
  @ApiOperation({ summary: "手动入库单个图片或视频切片" })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  publish(
    @Body(new ZodValidationPipe(publishAssetSchema))
    body: PublishAssetRequestDto,
  ) {
    return this.service.queueMutation("publish", publishAssetSchema.parse(body));
  }

  @Post("retry")
  @HttpCode(202)
  @ApiOperation({ summary: "重试失败的图片或父视频处理链" })
  @ApiBody({
    schema: {
      allOf: [
        { $ref: getSchemaPath(RetryAssetRequestDto) },
        { oneOf: [{ required: ["file_id"] }, { required: ["video_source_id"] }] },
      ],
    },
  })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  retry(
    @Body(new ZodValidationPipe(retryAssetSchema)) body: RetryAssetRequestDto,
  ) {
    return this.service.queueMutation("retry", retryAssetSchema.parse(body));
  }

  @Delete("delete")
  @HttpCode(202)
  @ApiOperation({ summary: "转公共、永久删除长期素材，或删除failed+processing原始上传" })
  @ApiBody({
    schema: {
      allOf: [
        { $ref: getSchemaPath(DeleteAssetRequestDto) },
        { oneOf: [{ required: ["file_id"] }, { required: ["video_source_id"] }] },
      ],
    },
  })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  delete(
    @Body(new ZodValidationPipe(deleteAssetSchema)) body: DeleteAssetRequestDto,
  ) {
    return this.service.queueMutation("delete", deleteAssetSchema.parse(body));
  }
}
