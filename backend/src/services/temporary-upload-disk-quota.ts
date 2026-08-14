export type TemporaryMediaHint = "image" | "video" | "unknown";

export interface TemporaryUploadQuotaLimits {
  imageBytes: number;
  videoBytes: number;
  batchBytes: number;
  processBytes: number;
  activeFiles: number;
}

interface BatchState {
  bytes: number;
  files: number;
  images: number;
  videos: number;
}

interface ActiveFile {
  owner: object;
  hint: TemporaryMediaHint;
  bytes: number;
}

export class TemporaryUploadQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporaryUploadQuotaError";
  }
}

/**
 * Accounts bytes while Multer is streaming them to disk. Batch counters are
 * deliberately not reduced when a file is released: a client cannot evade the
 * per-request cap by making an earlier part fail and continuing with later parts.
 */
export class TemporaryUploadDiskQuota {
  private readonly batches = new WeakMap<object, BatchState>();
  private readonly active = new Map<string, ActiveFile>();
  private processBytes = 0;

  constructor(private readonly limits: TemporaryUploadQuotaLimits) {}

  begin(owner: object, token: string, hint: TemporaryMediaHint) {
    if (this.active.has(token)) throw new TemporaryUploadQuotaError("临时上传文件标识重复。");
    if (this.active.size >= this.limits.activeFiles) throw new TemporaryUploadQuotaError("临时上传并发文件数已达到上限。");
    const batch = this.batches.get(owner) ?? { bytes: 0, files: 0, images: 0, videos: 0 };
    if (hint === "video" && batch.files > 0) throw new TemporaryUploadQuotaError("图片和视频不能混合；单次只能上传一个视频。");
    if (hint === "image" && batch.videos > 0) throw new TemporaryUploadQuotaError("图片和视频不能混合；单次只能上传一个视频。");
    if (hint === "video" && batch.videos > 0) throw new TemporaryUploadQuotaError("单次只能上传一个视频。");
    batch.files += 1;
    batch.images += hint === "image" ? 1 : 0;
    batch.videos += hint === "video" ? 1 : 0;
    this.batches.set(owner, batch);
    this.active.set(token, { owner, hint, bytes: 0 });
  }

  add(token: string, bytes: number) {
    const file = this.active.get(token);
    if (!file) throw new TemporaryUploadQuotaError("临时上传文件未登记。");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TemporaryUploadQuotaError("临时上传数据大小无效。");
    const batch = this.batches.get(file.owner)!;
    const nextFileBytes = file.bytes + bytes;
    const fileLimit = file.hint === "image" ? this.limits.imageBytes : this.limits.videoBytes;
    if (nextFileBytes > fileLimit) {
      throw new TemporaryUploadQuotaError(file.hint === "image" ? "图片超过20MB限制。" : "视频超过大小限制。");
    }
    if (batch.bytes + bytes > this.limits.batchBytes) throw new TemporaryUploadQuotaError("单次临时上传总大小超过限制。");
    if (this.processBytes + bytes > this.limits.processBytes) throw new TemporaryUploadQuotaError("临时上传服务磁盘配额不足，请稍后重试。");
    file.bytes = nextFileBytes;
    batch.bytes += bytes;
    this.processBytes += bytes;
  }

  release(token: string) {
    const file = this.active.get(token);
    if (!file) return;
    this.processBytes = Math.max(0, this.processBytes - file.bytes);
    this.active.delete(token);
  }

  snapshot() {
    return { activeFiles: this.active.size, processBytes: this.processBytes };
  }
}
