import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateVideoFile } from "@/server/media/video-validation";
import {
  extractVideoFirstFrame,
  extractVideoFramesToDirectory,
} from "@/server/media/video-frames";
import type { MediaTargetFormat } from "@/server/media/target-format";
import { SceneDetectClient } from "./client";
import {
  ScenePipelineError,
  type SceneSegment,
  type SceneSplitManifest,
} from "./types";

const mp4Target: MediaTargetFormat = {
  mediaType: "video",
  extension: ".mp4",
  mimeType: "video/mp4",
};

export interface PreparedSceneSegment extends SceneSegment {
  absolutePath: string;
  sizeBytes: number;
  thumbnailAbsolutePath: string;
  thumbnailSizeBytes: number;
  analysisFramesDirectory: string;
}

export interface PreparedSceneBatch {
  batchId: string;
  serviceTaskId: string;
  parentPath: string;
  durationSeconds: number;
  workspacePath: string;
  segments: PreparedSceneSegment[];
}

export interface PrepareSceneBatchInput {
  client: SceneDetectClient;
  normalizedParentPath: string;
  originalFilename: string;
  workspaceRoot: string;
  maximumSegmentBytes: number;
  /** 分片下载/验证/抽帧的并发上限（默认 8）；机器多核时串行会浪费资源 */
  concurrency?: number;
  signal?: AbortSignal;
}

function oversizeSegments(
  manifest: SceneSplitManifest,
  maximumSegmentBytes: number,
) {
  return manifest.segments
    .filter((segment) => segment.sizeBytes > maximumSegmentBytes)
    .map((segment) => ({
      segmentIndex: segment.index,
      actualBytes: segment.sizeBytes,
      maximumBytes: maximumSegmentBytes,
    }));
}

/** 最小信号量：限制并发任务数，超出部分排队等待（不引入外部依赖）。 */
class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ScenePipelineError(
        "scene_segment_invalid",
        "分片并发数必须是大于 0 的整数。",
        { concurrency: limit },
      );
    }
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * 完整准备一批视频切片。
 *
 * 原子边界截止到“所有切片均已下载、完整解码、标准化且不超过上限”。任一
 * 切片失败时会清除整批本地切片并通知分镜服务删除任务，不会把半批结果交给
 * 后续分析或持久化阶段。
 */
export async function prepareSceneBatch(
  input: PrepareSceneBatchInput,
): Promise<PreparedSceneBatch> {
  const batchId = crypto.randomUUID();
  const workspacePath = path.join(input.workspaceRoot, batchId);
  const segmentsPath = path.join(workspacePath, "segments");
  let manifest: SceneSplitManifest | undefined;

  try {
    await fs.mkdir(segmentsPath, { recursive: true });
    manifest = await input.client.splitVideo(
      input.normalizedParentPath,
      input.originalFilename,
      input.signal,
    );

    // splitVideo 成功后 manifest 必然存在；TS 在闭包内无法自动收窄，这里显式断言
    const splitManifest = manifest as SceneSplitManifest;
    const tooLarge = oversizeSegments(splitManifest, input.maximumSegmentBytes);
    if (tooLarge.length > 0) {
      const limitText = `${Math.round(input.maximumSegmentBytes / 1024 / 1024)} MiB`;
      throw new ScenePipelineError(
        "scene_segment_too_large",
        `${tooLarge.length} 个视频切片超过 ${limitText} 限制，父视频整批不入库。`,
        { segments: tooLarge },
      );
    }

    // 分片下载/验证/抽帧并发执行（信号量限流，默认 8），
    // 任一失败仍按段收集，整批回滚语义不变。
    const concurrency = input.concurrency ?? 8;
    const semaphore = new Semaphore(concurrency);
    const invalid: Array<Record<string, unknown>> = [];

    const processSegment = async (
      segment: SceneSplitManifest["segments"][number],
    ): Promise<PreparedSceneSegment | undefined> => {
      await semaphore.acquire();
      try {
        const absolutePath = path.join(
          segmentsPath,
          `segment-${String(segment.index).padStart(3, "0")}.mp4`,
        );
        try {
          const download = await input.client.downloadSegment(
            splitManifest,
            segment,
            absolutePath,
            input.maximumSegmentBytes,
            input.signal,
          );
          const validated = await validateVideoFile(
            absolutePath,
            mp4Target,
            download.sizeBytes,
            input.maximumSegmentBytes,
          );
          const thumbnailAbsolutePath = path.join(
            segmentsPath,
            `thumbnail-${String(segment.index).padStart(3, "0")}.jpg`,
          );
          const thumbnail = await extractVideoFirstFrame(
            absolutePath,
            thumbnailAbsolutePath,
          );
          const analysisFramesDirectory = path.join(
            segmentsPath,
            `analysis-frames-${String(segment.index).padStart(3, "0")}`,
          );
          await extractVideoFramesToDirectory(
            absolutePath,
            analysisFramesDirectory,
          );
          return {
            ...segment,
            absolutePath,
            sizeBytes: validated.sizeBytes,
            thumbnailAbsolutePath,
            thumbnailSizeBytes: thumbnail.sizeBytes,
            analysisFramesDirectory,
          };
        } catch (error) {
          invalid.push({
            segmentIndex: segment.index,
            code:
              error instanceof ScenePipelineError
                ? error.code
                : "scene_segment_invalid",
            message: error instanceof Error ? error.message : "未知切片错误",
            details:
              error instanceof ScenePipelineError ? error.details : undefined,
          });
        }
      } finally {
        semaphore.release();
      }
    };

    // Promise.all 的结果顺序与输入一致，避免并发完成顺序打乱 segmentIndex。
    const downloaded = await Promise.all(
      splitManifest.segments.map(processSegment),
    );

    if (invalid.length > 0) {
      throw new ScenePipelineError(
        "scene_segment_invalid",
        `${invalid.length} 个视频切片损坏、下载不完整或不符合媒体要求，父视频整批不入库。`,
        { segments: invalid },
      );
    }

    return {
      batchId,
      serviceTaskId: splitManifest.taskId,
      parentPath: input.normalizedParentPath,
      durationSeconds: splitManifest.durationSeconds,
      workspacePath,
      segments: downloaded.filter(
        (segment): segment is PreparedSceneSegment => Boolean(segment),
      ),
    };
  } catch (error) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    if (manifest) await input.client.deleteTask(manifest.taskId, input.signal);
    throw error;
  }
}

/** 成功持久化或主动放弃批次后，立即删除本地切片和分镜服务副本。 */
export async function cleanupPreparedSceneBatch(
  batch: Pick<PreparedSceneBatch, "serviceTaskId" | "workspacePath">,
  client: SceneDetectClient,
  signal?: AbortSignal,
) {
  const [remoteDeleted] = await Promise.all([
    client.deleteTask(batch.serviceTaskId, signal),
    fs.rm(batch.workspacePath, { recursive: true, force: true }),
  ]);
  return { remoteDeleted };
}
