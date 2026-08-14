import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { loadConfig } from "../config";

export interface ZosTemporaryUploadResult {
  url: string;
  key: string;
  size: number;
  contentType: string;
  uploadTime: string;
  expireTime: string;
  message: string;
}

@Injectable()
export class ZosService {
  private readonly config = loadConfig();
  private readonly client = new S3Client({
    endpoint: this.config.ZOS_API_ENDPOINT,
    region: this.config.ZOS_REGION,
    forcePathStyle: this.config.ZOS_FORCE_PATH_STYLE,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: this.config.ZOS_ACCESS_KEY_ID,
      secretAccessKey: this.config.ZOS_SECRET_ACCESS_KEY,
    },
  });

  get bucket() {
    return this.config.ZOS_BUCKET;
  }

  temporaryKey(id: string, extension: string) {
    return `${this.config.ZOS_TMP_PREFIX.replace(/\/$/, "")}/${id}.${extension}`;
  }

  permanentKey(id: string, extension: string) {
    return `${this.config.ZOS_PERMANENT_PREFIX.replace(/\/$/, "")}/${id}.${extension}`;
  }

  publicUrl(key: string) {
    return `${this.config.ZOS_WEB_URL.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async signedPut(key: string, contentType?: string) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ...(contentType ? { ContentType: contentType } : {}) }),
      { expiresIn: this.config.UPLOAD_URL_TTL_SECONDS },
    );
  }

  async put(key: string, body: Buffer, contentType: string, abortSignal?: AbortSignal) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: contentType,
    }), { abortSignal });
    const metadata = await this.head(key, abortSignal);
    if (metadata.sizeBytes !== body.byteLength) throw new Error("ZOS 上传后的对象大小不一致。");
    return { ...metadata, url: this.publicUrl(key) };
  }

  /**
   * 临时媒体由NestJS直接写入ZOS，不依赖额外上传服务，也不写MySQL。
   * key只能由本服务的tmp前缀、UUID和扩展名组成；失败时精确回收本次对象。
   */
  async putTemporary(
    id: string,
    extension: string,
    body: Buffer,
    contentType: string,
    abortSignal?: AbortSignal,
  ): Promise<ZosTemporaryUploadResult> {
    const key = this.temporaryKey(id, extension);
    try {
      const stored = await this.put(key, body, contentType, abortSignal);
      const uploadedAt = stored.lastModified ?? new Date();
      return {
        url: stored.url,
        key,
        size: stored.sizeBytes,
        contentType: stored.contentType,
        uploadTime: uploadedAt.toISOString(),
        expireTime: new Date(
          uploadedAt.getTime() + this.config.TEMP_FILE_TTL_HOURS * 3_600_000,
        ).toISOString(),
        message: `临时文件上传成功，将在${this.config.TEMP_FILE_TTL_HOURS}小时后清理`,
      };
    } catch (error) {
      await this.delete(key, AbortSignal.timeout(5_000)).catch(() => undefined);
      throw error;
    }
  }

  async head(key: string, abortSignal?: AbortSignal) {
    const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal });
    if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength! <= 0) {
      throw new Error("ZOS 对象不存在或为空。");
    }
    return { key, sizeBytes: response.ContentLength!, contentType: response.ContentType ?? "application/octet-stream", lastModified: response.LastModified };
  }

  async getBuffer(key: string, abortSignal?: AbortSignal) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal });
    if (!response.Body) throw new Error("ZOS 对象没有响应体。");
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async copy(sourceKey: string, destinationKey: string, abortSignal?: AbortSignal) {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: destinationKey,
      CopySource: `${this.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
    }), { abortSignal });
    return this.head(destinationKey, abortSignal);
  }

  async delete(key: string, abortSignal?: AbortSignal) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal });
  }

  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }
}
