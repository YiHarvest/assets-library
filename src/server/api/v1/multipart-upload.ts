import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import Busboy from "busboy";
import { ApiV1Error } from "@/server/api/errors";
import type { StagedUpload, StagedUploadFile } from "@/server/api/v1/service";
import { loadConfig } from "@/server/config";
import { targetFormatFromFilename } from "@/server/media/target-format";
import { writeAll } from "@/server/storage/object-storage";
import { uploadMetadataSchema } from "@/shared/contracts";

const allowedFields = new Set(["user_id", "callback_url", "auto_publish"]);

function multipartHeaders(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function uploadError(message: string, status = 400) {
  return new ApiV1Error("invalid_request", message, status);
}

/**
 * 将一个 multipart 请求直接流式写入该任务独占的 staging 目录。
 *
 * 解析阶段不相信浏览器声明的 MIME/大小；媒体类别只由文件名目标格式决定，
 * 字节数以实际落盘结果为准。任何字段或文件失败都会回收整个任务目录。
 */
export async function parseMultipartUpload(request: Request): Promise<StagedUpload> {
  if (!request.body) throw uploadError("multipart 上传内容不能为空。");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiV1Error(
      "unsupported_media_type",
      "Content-Type 必须是 multipart/form-data。",
      415,
    );
  }

  const config = loadConfig();
  const taskId = crypto.randomUUID();
  const taskDirectory = path.join(config.mediaRoot, ".staging", taskId);
  await fs.mkdir(taskDirectory, { recursive: true });

  const rawFields = new Map<string, string>();
  const files: StagedUploadFile[] = [];
  const writes: Promise<void>[] = [];
  let totalBytes = 0;
  let parserFailure: unknown;

  try {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: multipartHeaders(request.headers),
        defParamCharset: "utf8",
        limits: {
          files: 6,
          fields: 3,
          parts: 9,
          fieldNameSize: 64,
          fieldSize: 2_048,
          fileSize: config.UPLOAD_MAX_TOTAL_BYTES,
          headerPairs: 64,
        },
      });
    } catch {
      throw uploadError("multipart 边界参数无效。");
    }

    const abort = (error: unknown) => {
      parserFailure ??= error;
      // 解析器继续消费剩余请求体，最后统一抛出业务错误；避免 destroy(error)
      // 产生调用方无法关联的异步 error/unhandled rejection。
    };
    parser.on("filesLimit", () => abort(uploadError("每次最多接收五张图片或一个视频。")));
    parser.on("fieldsLimit", () => abort(uploadError("multipart 业务字段过多。")));
    parser.on("partsLimit", () => abort(uploadError("multipart 内容段过多。")));
    parser.on("field", (name, value, info) => {
      if (parserFailure) return;
      if (!allowedFields.has(name)) {
        abort(uploadError(`不支持 multipart 字段 ${name}。`));
        return;
      }
      if (info.valueTruncated) {
        abort(uploadError(`${name} 字段过长。`));
        return;
      }
      if (rawFields.has(name)) {
        abort(uploadError(`${name} 字段不能重复。`));
        return;
      }
      rawFields.set(name, value);
    });
    parser.on("file", (fieldName, stream, info) => {
      if (parserFailure) {
        stream.resume();
        return;
      }
      if (fieldName !== "files") {
        stream.resume();
        abort(uploadError(`文件字段必须命名为 files，收到 ${fieldName}。`));
        return;
      }
      const target = targetFormatFromFilename(info.filename);
      if (!target) {
        stream.resume();
        abort(
          new ApiV1Error(
            "unsupported_media_type",
            "图片仅支持 JPEG、PNG、WebP，视频仅支持 MP4。",
            415,
          ),
        );
        return;
      }
      const itemId = crypto.randomUUID();
      const stagingPath = path.posix.join(
        ".staging",
        taskId,
        `${itemId}${target.extension}`,
      );
      const destination = path.join(config.mediaRoot, ...stagingPath.split("/"));
      const temporary = `${destination}.uploading`;
      const item: StagedUploadFile = {
        id: itemId,
        ordinal: files.length,
        filename: info.filename,
        mediaType: target.mediaType,
        contentType: target.mimeType,
        sizeBytes: 0,
        stagingPath,
      };
      files.push(item);
      const maximumBytes =
        target.mediaType === "video"
          ? config.MAX_VIDEO_BYTES
          : config.MAX_IMAGE_BYTES;
      const write = (async () => {
        const handle = await fs.open(temporary, "wx");
        try {
          for await (const rawChunk of stream) {
            const chunk = Buffer.isBuffer(rawChunk)
              ? rawChunk
              : Buffer.from(rawChunk as Uint8Array);
            item.sizeBytes += chunk.byteLength;
            totalBytes += chunk.byteLength;
            if (
              item.sizeBytes > maximumBytes ||
              totalBytes > config.UPLOAD_MAX_TOTAL_BYTES
            ) {
              throw new ApiV1Error(
                "file_too_large",
                `${info.filename} 超过允许的上传大小。`,
                413,
                [
                  {
                    filename: info.filename,
                    size_bytes: item.sizeBytes,
                    limit_bytes: maximumBytes,
                  },
                ],
              );
            }
            await writeAll(handle, chunk);
          }
          if (stream.truncated) {
            throw new ApiV1Error("file_too_large", `${info.filename} 超过上传限制。`, 413);
          }
          if (item.sizeBytes === 0) throw uploadError(`${info.filename} 不能为空。`);
          await handle.sync();
          await handle.close();
          await fs.rename(temporary, destination);
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fs.rm(temporary, { force: true });
          throw error;
        }
      })();
      writes.push(write);
      void write.catch(abort);
    });

    const parserFinished = new Promise<void>((resolve, reject) => {
      parser.once("finish", resolve);
      parser.once("error", reject);
    });
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (!parser.write(Buffer.from(value))) await once(parser, "drain");
      }
      parser.end();
      await parserFinished;
      await Promise.all(writes);
      if (parserFailure) throw parserFailure;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw parserFailure ?? error;
    }

    if (files.length === 0) throw uploadError("至少上传一个 files 文件。 ");
    const videoCount = files.filter((file) => file.mediaType === "video").length;
    if (videoCount > 0 && (videoCount !== 1 || files.length !== 1)) {
      throw uploadError("每次只能上传一个视频，且不能与图片混合上传。");
    }
    if (videoCount === 0 && files.length > 5) {
      throw uploadError("每次最多上传五张图片。");
    }

    const metadata = uploadMetadataSchema.parse({
      user_id: rawFields.get("user_id"),
      callback_url: rawFields.get("callback_url"),
      auto_publish:
        rawFields.get("auto_publish") === undefined
          ? undefined
          : rawFields.get("auto_publish") === "true"
            ? true
            : rawFields.get("auto_publish") === "false"
              ? false
              : rawFields.get("auto_publish"),
    });
    return { taskId, ...metadata, files };
  } catch (error) {
    await fs.rm(taskDirectory, { recursive: true, force: true });
    throw error;
  }
}
