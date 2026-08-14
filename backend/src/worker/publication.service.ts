import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { assets, mediaObjects, taskFiles, videoSources } from "../database/schema";
import { ZosService } from "../storage/zos.service";
import { loadConfig } from "../config";
import { canAcquirePublicationLease, publicationLeaseDisposition, shouldDeleteCompensatingObject } from "./publication-policy";

type Asset = typeof assets.$inferSelect;
type MediaObject = typeof mediaObjects.$inferSelect;

interface Target { asset: Asset; media: MediaObject; cover: MediaObject | null }

function extension(object: MediaObject) {
  if (object.mimeType === "video/mp4") return "mp4";
  if (object.mimeType === "image/png") return "png";
  if (object.mimeType === "image/webp") return "webp";
  return path.extname(object.objectKey).replace(".", "") || "jpg";
}

export class PublicationService {
  private readonly config = loadConfig();
  constructor(private readonly database: DatabaseService, private readonly zos: ZosService) {}

  /** 单切片发布，或 auto_publish 视频对 task_file_id 下全部切片做补偿式原子发布。 */
  async publish(anchorId: string, wholeVideoBatch: boolean, requestedUserId?: string | null, signal?: AbortSignal) {
    const leaseToken = randomUUID();
    const targets = await this.reserve(anchorId, wholeVideoBatch, leaseToken);
    if (!targets.length) return [];
    const heartbeat = setInterval(() => {
      void this.database.db.update(assets).set({ publicationLeaseAt: new Date(), updatedAt: new Date() }).where(and(inArray(assets.id, targets.map((target) => target.asset.id)), eq(assets.publicationLeaseToken, leaseToken))).catch(() => undefined);
    }, Math.max(10_000, Math.floor(this.config.WORKER_STALE_SECONDS * 1000 / 3)));
    heartbeat.unref();
    const copied: Array<{ key: string; sourceKey: string }> = [];
    try {
      for (const target of targets) {
        const mediaKey = this.zos.permanentKey(target.asset.id, extension(target.media));
        await this.copyVerified(target.media, mediaKey, signal);
        copied.push({ key: mediaKey, sourceKey: target.media.objectKey });
        if (target.asset.mediaType === "video") {
          if (!target.cover) throw new Error(`视频切片 ${target.asset.id} 缺少封面。`);
          const coverKey = this.zos.permanentKey(`${target.asset.id}-cover`, "jpg");
          await this.copyVerified(target.cover, coverKey, signal);
          copied.push({ key: coverKey, sourceKey: target.cover.objectKey });
        }
      }
      await this.database.db.transaction(async (tx) => {
        const ids = targets.flatMap((target) => [target.media.id, ...(target.cover ? [target.cover.id] : [])]);
        const lockedAssets = await tx.select().from(assets).where(inArray(assets.id, targets.map((target) => target.asset.id))).for("update");
        if (lockedAssets.length !== targets.length || lockedAssets.some((asset) => asset.status !== "running" || asset.phase !== "processing" || asset.publicationLeaseToken !== leaseToken)) throw new Error("发布租约已失效。");
        const locked = await tx.select().from(mediaObjects).where(inArray(mediaObjects.id, ids)).for("update");
        if (locked.length !== ids.length || locked.some((object) => object.storageClass !== "temporary")) throw new Error("发布租约已失效。");
        const now = new Date();
        for (const target of targets) {
          const mediaKey = this.zos.permanentKey(target.asset.id, extension(target.media));
          await tx.update(mediaObjects).set({ objectKey: mediaKey, publicUrl: this.zos.publicUrl(mediaKey), storageClass: "permanent", updatedAt: now }).where(eq(mediaObjects.id, target.media.id));
          if (target.cover) {
            const coverKey = this.zos.permanentKey(`${target.asset.id}-cover`, "jpg");
            await tx.update(mediaObjects).set({ objectKey: coverKey, publicUrl: this.zos.publicUrl(coverKey), storageClass: "permanent", updatedAt: now }).where(eq(mediaObjects.id, target.cover.id));
          }
          await tx.update(assets).set({ userId: requestedUserId?.trim() || null, status: "done", phase: "published", errorCode: null, errorMessage: null, errorDetails: null, publicationLeaseToken: null, publicationLeaseAt: null, updatedAt: now }).where(and(eq(assets.id, target.asset.id), eq(assets.publicationLeaseToken, leaseToken)));
        }
      });
      const taskFileIds = [...new Set(targets.map((target) => target.asset.taskFileId).filter((id): id is string => Boolean(id)))];
      for (const taskFileId of taskFileIds) {
        const siblings = await this.database.db.query.assets.findMany({ where: eq(assets.taskFileId, taskFileId) });
        if (siblings.length && siblings.every((asset) => asset.phase !== "pending_review")) {
          const phase = siblings.some((asset) => asset.phase === "published") ? "published" : "expired";
          await this.database.db.update(taskFiles).set({ status: "done", phase, updatedAt: new Date() }).where(eq(taskFiles.id, taskFileId));
          const sourceIds = [...new Set(siblings.map((asset) => asset.videoSourceId).filter((id): id is string => Boolean(id)))];
          for (const sourceId of sourceIds) await this.database.db.update(videoSources).set({ status: "done", phase, updatedAt: new Date() }).where(eq(videoSources.id, sourceId));
        }
      }
    } catch (error) {
      await Promise.allSettled(copied.map(({ key }) => this.deleteIfUnreferenced(key)));
      const leasedIds = targets.map((target) => target.asset.id);
      await this.database.db.update(assets).set({ status: "pending_review", phase: "pending_review", publicationLeaseToken: null, publicationLeaseAt: null, updatedAt: new Date() }).where(and(inArray(assets.id, leasedIds), eq(assets.publicationLeaseToken, leaseToken))).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    // DB 已全部切换后回收 tmp，失败仅留下由 lifecycle 清理的副本。
    await Promise.allSettled(copied.map(({ sourceKey }) => this.zos.delete(sourceKey)));
    return targets.map((target) => target.asset.id);
  }

  private async reserve(anchorId: string, wholeVideoBatch: boolean, leaseToken: string) {
    return this.database.db.transaction(async (tx) => {
      const [anchor] = await tx.select().from(assets).where(eq(assets.id, anchorId)).for("update").limit(1);
      if (!anchor) throw new Error("待入库素材不存在。");
      const staleBefore = new Date(Date.now() - this.config.WORKER_STALE_SECONDS * 1000);
      const anchorDisposition = publicationLeaseDisposition({ ...anchor, updatedAt: anchor.publicationLeaseAt ?? anchor.updatedAt }, staleBefore);
      if (anchorDisposition === "already_published") return [];
      if (anchorDisposition === "busy") throw new Error("素材正在入库或并非待入库状态。");
      const candidates = wholeVideoBatch && anchor.mediaType === "video" && anchor.taskFileId
        ? await tx.select().from(assets).where(eq(assets.taskFileId, anchor.taskFileId)).for("update") : [anchor];
      if (candidates.some((asset) => !canAcquirePublicationLease({ ...asset, updatedAt: asset.publicationLeaseAt ?? asset.updatedAt }, staleBefore))) throw new Error("选中素材正在入库或并非待入库状态。");
      const ids = candidates.flatMap((asset) => [asset.mediaObjectId, ...(asset.coverObjectId ? [asset.coverObjectId] : [])]);
      const objects = await tx.select().from(mediaObjects).where(inArray(mediaObjects.id, ids)).for("update");
      const byId = new Map(objects.map((object) => [object.id, object]));
      const targets = candidates.map((asset) => {
        const media = byId.get(asset.mediaObjectId); const cover = asset.coverObjectId ? byId.get(asset.coverObjectId) ?? null : null;
        if (!media || media.storageClass !== "temporary" || (asset.mediaType === "video" && (!cover || cover.storageClass !== "temporary"))) throw new Error(`素材 ${asset.id} 的临时对象不完整。`);
        return { asset, media, cover } satisfies Target;
      });
      const leasedAt = new Date();
      await tx.update(assets).set({ status: "running", phase: "processing", publicationLeaseToken: leaseToken, publicationLeaseAt: leasedAt, updatedAt: leasedAt }).where(inArray(assets.id, candidates.map((asset) => asset.id)));
      return targets;
    });
  }

  private async copyVerified(source: MediaObject, key: string, signal?: AbortSignal) {
    const result = await this.zos.copy(source.objectKey, key, signal);
    if (result.sizeBytes !== source.sizeBytes) {
      await this.deleteIfUnreferenced(key).catch(() => undefined);
      throw new Error(`ZOS 复制校验失败：${key}`);
    }
  }

  private async deleteIfUnreferenced(key: string) {
    const referenced = await this.database.db.query.mediaObjects.findFirst({ where: and(eq(mediaObjects.objectKey, key), eq(mediaObjects.storageClass, "permanent")) });
    if (!shouldDeleteCompensatingObject(Boolean(referenced))) return;
    await this.zos.delete(key);
  }
}
