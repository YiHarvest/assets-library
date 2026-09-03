import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { loadConfig, type AppConfig } from "@/server/config";
import {
  formatObjectRange,
  normalizeObjectKey,
  publicObjectUrl,
  writeAll,
  type CopyObjectInput,
  type ObjectByteRange,
  type ObjectMetadata,
  type ObjectReadResult,
  type ObjectStorage,
  type StoreFileInput,
  type StoredObject,
} from "./object-storage";

export interface ZosObjectStorageOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  timeoutMs?: number;
  client?: S3Client;
}

/** 电信云 ZOS 的 S3 兼容对象存储适配器。 */
export class ZosObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl?: string;

  constructor(options: ZosObjectStorageOptions) {
    this.bucket = options.bucket;
    this.publicBaseUrl = options.publicBaseUrl;
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: "hangzhou-7",
        forcePathStyle: options.forcePathStyle ?? true,
        // 新版 AWS SDK 默认给所有 PUT 增加流式 CRC trailer；部分 ZOS S3
        // 兼容网关会将其误判为 x-amz-content-sha256 不一致。这里只在协议
        // 强制要求时启用 SDK checksum，上传后仍通过 HEAD 大小做完整性校验。
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
        requestHandler: new NodeHttpHandler({
          connectionTimeout: Math.min(options.timeoutMs ?? 300_000, 30_000),
          requestTimeout: options.timeoutMs ?? 300_000,
        }),
      });
  }

  async storeFile(input: StoreFileInput): Promise<StoredObject> {
    const key = normalizeObjectKey(input.key);
    const stat = await fsPromises.stat(input.filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("只能上传非空的本地文件到 ZOS。");
    }
    let response;
    try {
      response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: fs.createReadStream(input.filePath),
          ContentLength: stat.size,
          ContentType: input.contentType,
        }),
      );
      const verified = await this.headObject(key);
      if (verified.sizeBytes !== stat.size) {
        throw new Error(
          `ZOS 上传后大小不一致：本地 ${stat.size} 字节，远端 ${verified.sizeBytes} 字节。`,
        );
      }
    } catch (error) {
      // PUT 可能已在服务端成功但客户端未收到响应，因此总是按 key 补偿删除。
      await this.deleteObject(key).catch(() => undefined);
      throw error;
    }
    return {
      key,
      sizeBytes: stat.size,
      etag: response.ETag?.replaceAll('"', ""),
      url: publicObjectUrl(this.publicBaseUrl, key),
    };
  }

  async copyObject(input: CopyObjectInput): Promise<StoredObject> {
    const sourceKey = normalizeObjectKey(input.sourceKey);
    const destinationKey = normalizeObjectKey(input.destinationKey);
    if (sourceKey === destinationKey) {
      throw new Error("ZOS 复制的源对象和目标对象不能相同。");
    }
    const source = await this.headObject(sourceKey);
    const encodedSource = [this.bucket, ...sourceKey.split("/")]
      .map(encodeURIComponent)
      .join("/");
    const response = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: encodedSource,
      }),
    );
    const copied = await this.headObject(destinationKey);
    if (copied.sizeBytes !== source.sizeBytes) {
      throw new Error(
        `ZOS 复制后大小不一致：源对象 ${source.sizeBytes} 字节，目标对象 ${copied.sizeBytes} 字节。`,
      );
    }
    return {
      key: destinationKey,
      sizeBytes: copied.sizeBytes,
      etag: response.CopyObjectResult?.ETag?.replaceAll('"', "") ?? copied.etag,
      url: publicObjectUrl(this.publicBaseUrl, destinationKey),
    };
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    const normalizedKey = normalizeObjectKey(key);
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: normalizedKey }),
    );
    if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength! < 0) {
      throw new Error("ZOS 未返回有效的对象大小。");
    }
    return {
      key: normalizedKey,
      sizeBytes: response.ContentLength!,
      contentType: response.ContentType,
      etag: response.ETag?.replaceAll('"', ""),
      lastModified: response.LastModified,
    };
  }

  async getObject(
    key: string,
    range?: ObjectByteRange,
  ): Promise<ObjectReadResult> {
    const normalizedKey = normalizeObjectKey(key);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
        Range: range ? formatObjectRange(range) : undefined,
      }),
    );
    const body = response.Body;
    if (!body || typeof body.transformToWebStream !== "function") {
      throw new Error("ZOS 未返回可读取的对象流。");
    }
    const contentLength = response.ContentLength;
    if (!Number.isSafeInteger(contentLength) || contentLength! < 0) {
      throw new Error("ZOS 未返回有效的响应体大小。");
    }
    const totalFromRange = response.ContentRange?.match(/\/(\d+)$/)?.[1];
    const totalSize = totalFromRange
      ? Number.parseInt(totalFromRange, 10)
      : range
        ? (await this.headObject(normalizedKey)).sizeBytes
        : contentLength!;
    return {
      key: normalizedKey,
      body: body.transformToWebStream(),
      sizeBytes: totalSize,
      contentLength: contentLength!,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
      etag: response.ETag?.replaceAll('"', ""),
      lastModified: response.LastModified,
    };
  }

  async downloadToFile(
    key: string,
    destinationPath: string,
  ): Promise<ObjectMetadata> {
    const expected = await this.headObject(key);
    const result = await this.getObject(key);
    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    const temporaryPath = `${destinationPath}.download`;
    const output = await fsPromises.open(temporaryPath, "wx");
    let receivedBytes = 0;
    try {
      const reader = result.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > expected.sizeBytes) {
          await reader.cancel();
          throw new Error("ZOS 下载内容大于对象元数据声明的大小。");
        }
        await writeAll(output, value);
      }
      if (receivedBytes !== expected.sizeBytes) {
        throw new Error(
          `ZOS 下载不完整：期望 ${expected.sizeBytes} 字节，实际 ${receivedBytes} 字节。`,
        );
      }
      await output.sync();
      await output.close();
      await fsPromises.rename(temporaryPath, destinationPath);
      return expected;
    } catch (error) {
      await output.close().catch(() => undefined);
      await fsPromises.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async deleteObject(key: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: normalizeObjectKey(key),
      }),
    );
  }
}

/** 从项目配置创建 ZOS 适配器；缺少任一必需配置时立即失败。 */
export function createZosObjectStorage(
  config: AppConfig = loadConfig(),
): ZosObjectStorage {
  const endpoint =
    config.ZOS_API_ENDPOINT?.trim() ||
    config.ZOS_ENDPOINT?.trim() ||
    config.ZOS_INTERNAL_URL?.trim();
  const bucket = config.ZOS_BUCKET?.trim();
  const accessKeyId = config.ZOS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = config.ZOS_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "ZOS 配置不完整：需要一个 ZOS API endpoint、ZOS_BUCKET、ZOS_ACCESS_KEY_ID 和 ZOS_SECRET_ACCESS_KEY。",
    );
  }
  return new ZosObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: config.ZOS_WEB_URL?.trim() || undefined,
    forcePathStyle: config.ZOS_FORCE_PATH_STYLE,
    timeoutMs: config.ZOS_TIMEOUT_MS,
  });
}
