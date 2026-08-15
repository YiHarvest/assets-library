import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import type {
  VideoFrameManifest,
  VideoFrameUploadMetadata,
} from "@/shared/video-frames";

export function ensureStorage() {
  const { mediaRoot } = loadConfig();
  fs.mkdirSync(path.join(mediaRoot, ".tmp"), { recursive: true });
  return mediaRoot;
}

export function temporaryUploadPath(id: string) {
  return path.join(ensureStorage(), ".tmp", `${id}.upload`);
}

export function assetRelativePath(assetId: string, extension: string) {
  return path.join(assetId, `original${extension.toLowerCase()}`);
}

export function analysisRelativePath(jobId: string, extension: string) {
  return path.posix.join(
    ".analysis",
    jobId,
    `original${extension.toLowerCase()}`,
  );
}

export function resolveMediaPath(
  relativePath: string,
  configuredRoot = loadConfig().mediaRoot,
) {
  const root = path.resolve(configuredRoot);
  fs.mkdirSync(root, { recursive: true });
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AppError("storage_error", "检测到不安全的媒体路径。", 500);
  }
  return resolved;
}

export function moveIntoAssetStorage(
  temporaryPath: string,
  assetId: string,
  extension: string,
) {
  const relativePath = assetRelativePath(assetId, extension);
  const target = resolveMediaPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(temporaryPath, target);
  return relativePath;
}

export function storeVideoFrames(
  originalRelativePath: string,
  uploads: Array<{ temporaryPath: string; timestampSeconds: number }>,
  metadata: VideoFrameUploadMetadata,
) {
  const originalPath = resolveMediaPath(originalRelativePath);
  const frameDirectory = path.join(path.dirname(originalPath), "frames");
  const stagingDirectory = `${frameDirectory}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(stagingDirectory, { recursive: true });
    const frames = uploads.map((upload, index) => {
      const filename = `frame-${String(index + 1).padStart(2, "0")}.jpg`;
      fs.renameSync(upload.temporaryPath, path.join(stagingDirectory, filename));
      return { filename, timestampSeconds: upload.timestampSeconds };
    });
    const manifest = {
      durationSeconds: metadata.durationSeconds,
      frames,
    } satisfies VideoFrameManifest;
    fs.writeFileSync(
      path.join(stagingDirectory, "manifest.json"),
      JSON.stringify(manifest),
    );
    fs.rmSync(frameDirectory, { recursive: true, force: true });
    fs.renameSync(stagingDirectory, frameDirectory);
  } catch {
    throw new AppError("storage_error", "视频关键帧保存失败，请重试。", 500);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    for (const upload of uploads) {
      fs.rmSync(upload.temporaryPath, { force: true });
    }
  }
}

export function readVideoFrameSet(
  originalRelativePath: string,
  configuredRoot = loadConfig().mediaRoot,
) {
  const originalPath = resolveMediaPath(originalRelativePath, configuredRoot);
  const frameDirectory = path.join(path.dirname(originalPath), "frames");
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(frameDirectory, "manifest.json"), "utf8"),
    ) as VideoFrameManifest;
    if (
      !Number.isFinite(manifest.durationSeconds) ||
      manifest.durationSeconds <= 0 ||
      !Array.isArray(manifest.frames) ||
      manifest.frames.length < 1 ||
      manifest.frames.length > 5
    ) {
      throw new Error("Invalid frame manifest.");
    }
    const frames = manifest.frames.map((frame) => {
      if (
        !/^frame-\d{2}\.jpg$/.test(frame.filename) ||
        !Number.isFinite(frame.timestampSeconds) ||
        frame.timestampSeconds < 0
      ) {
        throw new Error("Invalid frame entry.");
      }
      const absolutePath = path.resolve(frameDirectory, frame.filename);
      if (
        !absolutePath.startsWith(`${frameDirectory}${path.sep}`) ||
        !fs.existsSync(absolutePath)
      ) {
        throw new Error("Unsafe frame path.");
      }
      return { ...frame, absolutePath };
    });
    return { durationSeconds: manifest.durationSeconds, frames };
  } catch {
    throw new AppError("video_frames_missing");
  }
}

export function readVideoFrames(
  originalRelativePath: string,
  configuredRoot = loadConfig().mediaRoot,
) {
  return readVideoFrameSet(originalRelativePath, configuredRoot).frames;
}

/**
 * 把分镜阶段生成的关键帧原子复制到分析作业工作区。original 文件无需存在；
 * readVideoFrames 只根据其父目录定位 frames 清单。
 */
export async function seedAnalysisVideoFrames(
  jobId: string,
  extension: string,
  sourceFrameDirectory: string,
  configuredRoot = loadConfig().mediaRoot,
) {
  const relativePath = analysisRelativePath(jobId, extension);
  const originalPath = resolveMediaPath(relativePath, configuredRoot);
  const workspace = path.dirname(originalPath);
  const stagingWorkspace = `${workspace}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(stagingWorkspace, { recursive: true });
    await fs.promises.cp(
      sourceFrameDirectory,
      path.join(stagingWorkspace, "frames"),
      { recursive: true, errorOnExist: true },
    );
    await fs.promises.rm(workspace, { recursive: true, force: true });
    await fs.promises.rename(stagingWorkspace, workspace);
    // 用正式读取路径校验复制后的清单与帧，避免把损坏种子交给 worker。
    readVideoFrames(relativePath, configuredRoot);
    return { relativePath, workspace };
  } catch (error) {
    await fs.promises.rm(stagingWorkspace, { recursive: true, force: true });
    await fs.promises.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function removeAnalysisWorkspace(
  jobId: string,
  configuredRoot = loadConfig().mediaRoot,
) {
  const originalPath = resolveMediaPath(
    analysisRelativePath(jobId, ".bin"),
    configuredRoot,
  );
  await fs.promises.rm(path.dirname(originalPath), {
    recursive: true,
    force: true,
  });
}

export function removeAssetFiles(relativePath: string) {
  const absolutePath = resolveMediaPath(relativePath);
  const assetDirectory = path.dirname(absolutePath);
  if (fs.existsSync(assetDirectory)) {
    fs.rmSync(assetDirectory, { recursive: true, force: true });
  }
}
