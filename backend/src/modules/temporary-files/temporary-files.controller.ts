import { Controller, Post, UploadedFiles, UseInterceptors, Body, HttpCode, PayloadTooLargeException, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { FilesInterceptor } from "@nestjs/platform-express";
import { createWriteStream, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiBadRequestResponse,
  ApiPayloadTooLargeResponse,
  ApiRequestTimeoutResponse,
  ApiInternalServerErrorResponse,
} from "@nestjs/swagger";
import {
  TemporaryUploadRequestDto,
  TemporaryUploadResponseDto,
  ErrorResponseDto,
} from "../../contracts/dtos";
import { TemporaryUploadService } from "../../services/temporary-upload.service";
import type { TemporaryMediaHint } from "../../services/temporary-upload-disk-quota";
import { TemporaryUploadExceptionFilter } from "./temporary-upload-exception.filter";
import { temporaryUploadQuota } from "../../services/temporary-upload-quota.singleton";
import { TemporaryUploadIpRateLimitGuard } from "../../services/temporary-upload-rate-limit.service";

type StorageCallback = (error: Error | null, info?: Partial<Express.Multer.File>) => void;
type RemoveCallback = (error: Error | null) => void;

function mediaHint(file: Express.Multer.File): TemporaryMediaHint {
  const name = file.originalname.toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) || /\.(jpe?g|png|webp)$/.test(name)) return "image";
  if (file.mimetype === "video/mp4" || name.endsWith(".mp4")) return "video";
  return "unknown";
}

export const streamingStorage = {
  _handleFile(request: Request, file: Express.Multer.File, callback: StorageCallback) {
    const destination = path.resolve(process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".run"), "temporary-uploads");
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}.uploading`;
    const target = path.join(destination, filename);
    const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
    let size = 0;
    let finished = false;
    const done = (error: Error | null, info?: Partial<Express.Multer.File>) => {
      if (finished) return;
      finished = true;
      if (error) {
        temporaryUploadQuota().release(target);
        output.destroy();
        file.stream.resume();
        void rm(target, { force: true });
      }
      callback(error, info);
    };
    try {
      temporaryUploadQuota().begin(request, target, mediaHint(file));
    } catch (error) {
      done(new PayloadTooLargeException(error instanceof Error ? error.message : "临时上传超过限制。"));
      return;
    }
    file.stream.on("data", (chunk: Buffer) => {
      if (finished) return;
      try {
        temporaryUploadQuota().add(target, chunk.byteLength);
        size += chunk.byteLength;
      } catch (error) {
        file.stream.unpipe(output);
        done(new PayloadTooLargeException(error instanceof Error ? error.message : "临时上传超过限制。"));
      }
    });
    file.stream.once("error", (error) => done(error));
    output.once("error", (error) => done(error));
    output.once("finish", () => done(null, { destination, filename, path: target, size }));
    file.stream.pipe(output);
  },
  _removeFile(_request: Request, file: Express.Multer.File, callback: RemoveCallback) {
    if (!file.path) return callback(null);
    temporaryUploadQuota().release(file.path);
    void rm(file.path, { force: true }).then(() => callback(null), callback);
  },
};

@ApiTags("temporary-files")
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiPayloadTooLargeResponse({ type: ErrorResponseDto })
@ApiRequestTimeoutResponse({ type: ErrorResponseDto, description: "请求体接收或同步媒体处理超过60秒。" })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@UseFilters(TemporaryUploadExceptionFilter)
@UseGuards(TemporaryUploadIpRateLimitGuard)
@Controller("temporary-files")
export class TemporaryFilesController {
  constructor(private readonly service: TemporaryUploadService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "同步上传临时图片或视频" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: TemporaryUploadRequestDto })
  @ApiOkResponse({ type: TemporaryUploadResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: "user_id 或来源 IP 的临时上传速率超过限制；错误码仍为invalid_file。" })
  @UseInterceptors(FilesInterceptor("files", 9, {
    storage: streamingStorage,
    limits: { files: 9, fileSize: 200 * 1024 * 1024 },
  }))
  async upload(
    @Body("user_id") userId: unknown,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.service.upload(userId, files ?? [], AbortSignal.timeout(60_000));
  }
}
