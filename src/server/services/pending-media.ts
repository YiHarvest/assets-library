import fs from "node:fs/promises";
import path from "node:path";
import { resolveMediaPath } from "@/server/media/storage";
import type { ObjectStorage, StoredObject } from "@/server/storage/object-storage";

/** 待审核媒体按素材隔离，发布成功或过期回收时可整目录原子清理。 */
export function pendingAssetPath(assetId: string, filename: string) {
  return path.posix.join(".pending", assetId, filename);
}

/** 复制而非移动 staging；数据库提交失败时原始上传仍可安全重试。 */
export async function copyPendingObject(input: {
  sourcePath: string;
  relativePath: string;
  mediaRoot: string;
}): Promise<StoredObject> {
  const target = resolveMediaPath(input.relativePath, input.mediaRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(input.sourcePath, target);
  const stat = await fs.stat(target);
  return { key: input.relativePath, sizeBytes: stat.size };
}

/** 删除一个待审核素材的本体、缩略图和分析关键帧。 */
export async function removePendingAsset(
  localPath: string,
  mediaRoot: string,
) {
  const absolutePath = resolveMediaPath(localPath, mediaRoot);
  await fs.rm(path.dirname(absolutePath), { recursive: true, force: true });
}

export interface DeletableMediaObject {
  provider: "local" | "zos";
  objectKey: string;
  localPath: string | null;
}

/** 媒体生命周期统一删除入口；本地对象绝不能误发 ZOS DELETE。 */
export async function deleteMediaObjectBytes(
  object: DeletableMediaObject,
  storage: ObjectStorage,
  mediaRoot: string,
) {
  if (object.provider === "local") {
    if (object.localPath) await removePendingAsset(object.localPath, mediaRoot);
    return;
  }
  await storage.deleteObject(object.objectKey);
}
