import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReceiveUploadItemInput } from "@/server/api/v1/service";
import type { AppConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import { AppError } from "@/server/errors";
import { targetFormatFromFilename } from "@/server/media/target-format";
import type * as AssetRepository from "@/server/repositories/assets";
import { writeAll } from "@/server/storage/object-storage";
import type { CreateUploadTask } from "@/shared/contracts";
import type { TaskService } from "@/server/modules/tasks/task-service";

const uploadProgressFlushBytes = 4 * 1024 * 1024;

type UploadRepository = Pick<
  typeof AssetRepository,
  | "acquireTaskItemUploadLease"
  | "createTaskWithItems"
  | "releaseTaskItemUploadLease"
  | "sealTaskIfComplete"
  | "updateTaskItemUploadProgress"
>;

export interface UploadServiceDependencies {
  config: () => AppConfig;
  repository: UploadRepository;
  tasks: Pick<TaskService, "getTask">;
}

function stagingRelativePath(taskId: string, itemId: string, filename: string) {
  const target = targetFormatFromFilename(filename);
  if (!target) {
    throw new ApiV1Error(
      "unsupported_media_type",
      "图片仅支持 JPEG、PNG、WebP，视频目标格式仅支持 MP4。",
      415,
    );
  }
  return path.posix.join(".staging", taskId, `${itemId}${target.extension}`);
}

export function resolveStagingPath(mediaRoot: string, relativePath: string) {
  const root = path.resolve(mediaRoot);
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ApiV1Error("storage_error", "上传暂存路径无效。", 500);
  }
  return absolute;
}

async function writeUploadBody(
  repository: UploadRepository,
  input: ReceiveUploadItemInput,
  expectedBytes: number,
  destination: string,
) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.uploading`;
  const handle = await fs.open(temporary, "wx");
  let received = 0;
  let lastFlushed = 0;
  try {
    const reader = input.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > expectedBytes) {
        throw new ApiV1Error(
          "upload_size_mismatch",
          "实际上传字节数超过清单声明大小。",
          409,
        );
      }
      await writeAll(handle, value);
      if (received - lastFlushed >= uploadProgressFlushBytes) {
        await repository.updateTaskItemUploadProgress({
          taskId: input.taskId,
          itemId: input.itemId,
          receivedBytes: received,
        });
        lastFlushed = received;
      }
    }
    if (received !== expectedBytes) {
      throw new ApiV1Error(
        "upload_size_mismatch",
        `实际上传 ${received} 字节，与声明的 ${expectedBytes} 字节不一致。`,
        409,
      );
    }
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, destination);
    return received;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function normalizeUploadRepositoryError(error: unknown) {
  if (!(error instanceof AppError)) return error;
  if (error.status === 404) {
    return new ApiV1Error("not_found", error.message, 404);
  }
  if (error.status === 409) {
    return new ApiV1Error("conflict", error.message, 409);
  }
  return new ApiV1Error("invalid_request", error.message, error.status);
}

export class UploadService {
  constructor(private readonly dependencies: UploadServiceDependencies) {}

  async createUploadTask(input: CreateUploadTask) {
    const config = this.dependencies.config();
    if (input.items.length > config.UPLOAD_MAX_ITEMS) {
      throw new ApiV1Error(
        "file_too_large",
        `每个上传任务最多包含 ${config.UPLOAD_MAX_ITEMS} 个文件。`,
        413,
      );
    }
    const totalBytes = input.items.reduce(
      (total, item) => total + item.size_bytes,
      0,
    );
    if (totalBytes > config.UPLOAD_MAX_TOTAL_BYTES) {
      throw new ApiV1Error(
        "file_too_large",
        `上传任务总大小不得超过 ${config.UPLOAD_MAX_TOTAL_BYTES} 字节。`,
        413,
        [{ size_bytes: totalBytes, limit_bytes: config.UPLOAD_MAX_TOTAL_BYTES }],
      );
    }
    const taskId = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + config.TASK_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    const manifests = input.items.map((item, ordinal) => {
      const id = crypto.randomUUID();
      return {
        id,
        ordinal,
        filename: item.filename,
        declaredContentType: item.content_type,
        totalBytes: item.size_bytes,
        stagingPath: stagingRelativePath(taskId, id, item.filename),
      };
    });
    await this.dependencies.repository.createTaskWithItems({
      id: taskId,
      type: "upload",
      userId: input.user_id,
      callbackUrl: input.callback_url,
      expiresAt,
      result: { auto_publish: input.auto_publish },
      items: manifests,
    });
    return this.dependencies.tasks.getTask(taskId);
  }

  async receiveUploadItem(input: ReceiveUploadItemInput) {
    const repository = this.dependencies.repository;
    let leaseAcquired = false;
    let destination: string | undefined;
    try {
      const lease = await repository.acquireTaskItemUploadLease({
        taskId: input.taskId,
        itemId: input.itemId,
      });
      if (lease.state === "already_complete") {
        return this.dependencies.tasks.getTask(input.taskId);
      }
      leaseAcquired = true;
      const { item } = lease;
      if (
        input.contentLength !== null &&
        input.contentLength !== item.totalBytes
      ) {
        throw new ApiV1Error(
          "upload_size_mismatch",
          "Content-Length 与上传清单声明大小不一致。",
          409,
        );
      }

      destination = resolveStagingPath(
        this.dependencies.config().mediaRoot,
        item.stagingPath,
      );
      await fs.rm(destination, { force: true });
      const received = await writeUploadBody(
        repository,
        input,
        item.totalBytes,
        destination,
      );
      await repository.updateTaskItemUploadProgress({
        taskId: input.taskId,
        itemId: input.itemId,
        receivedBytes: received,
        completed: true,
      });
      leaseAcquired = false;
      return this.dependencies.tasks.getTask(input.taskId);
    } catch (error) {
      if (leaseAcquired) {
        const released = await repository
          .releaseTaskItemUploadLease({
            taskId: input.taskId,
            itemId: input.itemId,
          })
          .catch(() => false);
        if (released && destination) {
          await fs.rm(destination, { force: true }).catch(() => undefined);
        }
      }
      throw normalizeUploadRepositoryError(error);
    }
  }

  async sealUploadTask(taskId: string) {
    await this.dependencies.repository.sealTaskIfComplete(taskId);
    return this.dependencies.tasks.getTask(taskId);
  }
}
