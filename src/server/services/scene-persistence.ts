import crypto from "node:crypto";
import type { ObjectStorage, StoredObject } from "@/server/storage/object-storage";
import type { PreparedSceneBatch } from "@/server/scene/batch";
import { ScenePipelineError } from "@/server/scene/types";
import {
  copyPendingObject,
  pendingAssetPath,
  removePendingAsset,
} from "@/server/services/pending-media";

export interface PersistedSceneSegment {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sizeBytes: number;
  object: StoredObject;
  thumbnailObject: StoredObject;
}

export interface PersistedSceneBatch {
  segments: PersistedSceneSegment[];
}

export interface PersistSceneBatchInput {
  batch: PreparedSceneBatch;
  storage: ObjectStorage;
  /**
   * 必须在一个 MySQL 事务内建立父视频与全部子素材，并只在事务提交后返回。
   * 回调抛错时，本函数会补偿删除本批已经上传的所有 ZOS 对象。
   */
  commitDatabase: (batch: PersistedSceneBatch) => Promise<void>;
  now?: Date;
}

export interface PersistLocalSceneBatchInput {
  batch: PreparedSceneBatch;
  /** 必须与 batch.segments 顺序、数量完全一致。 */
  assetIds: string[];
  mediaRoot: string;
  commitDatabase: (batch: PersistedSceneBatch) => Promise<void>;
}

function objectPrefix(now: Date, batchId: string) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `assets/videos/${year}/${month}/${day}/${batchId}`;
}

/**
 * 将全部切片及其首帧作为一个可见性原子批次持久化。
 *
 * 父视频只用于本地分镜，绝不进入 ZOS。ZOS 不支持与 MySQL 共用事务，因此
 * 这里采用“先上传不可见对象，再提交单个
 * MySQL 事务；数据库失败则反向补偿删除对象”的 Saga。数据库不会出现半批
 * 素材；极端崩溃留下的孤儿对象应由离线清理任务按 key 前缀回收。
 */
export async function persistSceneBatch(
  input: PersistSceneBatchInput,
): Promise<PersistedSceneBatch> {
  const prefix = objectPrefix(input.now ?? new Date(), input.batch.batchId);
  const uploaded: StoredObject[] = [];
  try {
    const segments: PersistedSceneSegment[] = [];
    for (const segment of input.batch.segments) {
      const object = await input.storage.storeFile({
        key: `${prefix}/segments/${String(segment.index).padStart(3, "0")}-${crypto.randomUUID()}.mp4`,
        filePath: segment.absolutePath,
        contentType: "video/mp4",
      });
      uploaded.push(object);
      const thumbnailObject = await input.storage.storeFile({
        key: `${prefix}/thumbnails/${String(segment.index).padStart(3, "0")}-${crypto.randomUUID()}.jpg`,
        filePath: segment.thumbnailAbsolutePath,
        contentType: "image/jpeg",
      });
      uploaded.push(thumbnailObject);
      segments.push({
        index: segment.index,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        durationSeconds: segment.durationSeconds,
        sizeBytes: object.sizeBytes,
        object,
        thumbnailObject,
      });
    }

    const persisted = { segments };
    await input.commitDatabase(persisted);
    return persisted;
  } catch (error) {
    const cleanupResults = await Promise.allSettled(
      uploaded.reverse().map((object) => input.storage.deleteObject(object.key)),
    );
    const cleanupFailures = cleanupResults.filter(
      (result) => result.status === "rejected",
    ).length;
    throw new ScenePipelineError(
      "scene_persistence_failed",
      "视频切片批次未能完整写入 ZOS 和 MySQL，整批已取消。",
      {
        uploadedObjectCount: uploaded.length,
        cleanupFailures,
      },
      { cause: error },
    );
  }
}

/**
 * 将待审核切片和首帧复制到 media/.pending，并在单个事务内建档。
 *
 * 这里故意保留分镜工作区源文件直到数据库提交完成；任一步失败都会删除已复制
 * 的素材目录，父上传 staging 则留给 24 小时失败任务回收机制处理。
 */
export async function persistLocalSceneBatch(
  input: PersistLocalSceneBatchInput,
): Promise<PersistedSceneBatch> {
  if (input.assetIds.length !== input.batch.segments.length) {
    throw new ScenePipelineError(
      "scene_persistence_failed",
      "视频切片与待审核素材标识数量不一致，整批已取消。",
    );
  }
  const copiedPaths: string[] = [];
  try {
    const segments: PersistedSceneSegment[] = [];
    for (const [offset, segment] of input.batch.segments.entries()) {
      const assetId = input.assetIds[offset]!;
      const objectPath = pendingAssetPath(assetId, "original.mp4");
      const thumbnailPath = pendingAssetPath(assetId, "thumbnail.jpg");
      const object = await copyPendingObject({
        sourcePath: segment.absolutePath,
        relativePath: objectPath,
        mediaRoot: input.mediaRoot,
      });
      copiedPaths.push(objectPath);
      const thumbnailObject = await copyPendingObject({
        sourcePath: segment.thumbnailAbsolutePath,
        relativePath: thumbnailPath,
        mediaRoot: input.mediaRoot,
      });
      segments.push({
        index: segment.index,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        durationSeconds: segment.durationSeconds,
        sizeBytes: object.sizeBytes,
        object,
        thumbnailObject,
      });
    }
    const persisted = { segments };
    await input.commitDatabase(persisted);
    return persisted;
  } catch (error) {
    await Promise.allSettled(
      copiedPaths.map((localPath) =>
        removePendingAsset(localPath, input.mediaRoot),
      ),
    );
    throw new ScenePipelineError(
      "scene_persistence_failed",
      "视频切片批次未能完整写入本地待审核区和 MySQL，整批已取消。",
      undefined,
      { cause: error },
    );
  }
}
