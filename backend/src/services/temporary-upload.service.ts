import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HttpException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import sharp from "sharp";
import { loadConfig } from "../config";
import { ZosService } from "../storage/zos.service";
import { displayDimensions } from "../analysis/image-dimensions";
import { releaseTemporaryUploadFile } from "./temporary-upload-quota.singleton";
import { TemporaryUploadRateLimitService } from "./temporary-upload-rate-limit.service";

function signalError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("临时上传处理已取消。");
}

function run(command: string, args: string[], signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); signal.removeEventListener("abort", abort); code === 0 ? resolve() : reject(new Error(stderr || `${command} 退出码 ${code}`)); });
  });
}

function capture(command: string, args: string[], signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); signal.removeEventListener("abort", abort); code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} 退出码 ${code}`)); });
  });
}

@Injectable()
export class TemporaryUploadService {
  private readonly config = loadConfig();
  constructor(
    private readonly zos: ZosService,
    private readonly rateLimit: TemporaryUploadRateLimitService,
  ) {}

  async upload(userId: unknown, files: Express.Multer.File[], signal: AbortSignal) {
    if (typeof userId !== "string" || !userId.trim() || userId.length > 191) {
      throw new UnprocessableEntityException("user_id 必须是1到191字符的字符串且不能重复。");
    }
    const userIdHash = createHmac("sha256", this.config.TEMP_UPLOAD_AUDIT_SALT)
      .update(userId.trim())
      .digest("hex");
    this.rateLimit.consumeUser(userIdHash);
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      kind: "temporary_upload_audit",
      user_id_hash: userIdHash,
      file_count: files.length,
    })}\n`);
    if (!files.length) throw new UnprocessableEntityException("至少上传一个文件。");
    const videoFiles = files.filter((file) => file.mimetype === "video/mp4" || file.originalname.toLowerCase().endsWith(".mp4"));
    if (videoFiles.length && (videoFiles.length !== 1 || files.length !== 1)) {
      throw new UnprocessableEntityException("图片和视频不能混合；单次只能上传一个视频。");
    }
    if (!videoFiles.length && files.length > 9) throw new UnprocessableEntityException("单次最多上传9张图片。");
    const createdAt = new Date();
    const results = [];
    try {
      // 顺序处理，避免9张图片同时驻留内存。
      for (const file of files) {
        if (signal.aborted) throw new HttpException("临时上传处理超过60秒。", 408);
        results.push(await this.process(file, signal));
      }
    } finally {
      await Promise.allSettled(files.filter((file) => file.path).map(async (file) => {
        try { await rm(file.path, { force: true }); } finally { releaseTemporaryUploadFile(file.path); }
      }));
    }
    const done = results.filter((result) => result.status === "done").length;
    return {
      // 图片批次允许部分成功；只要至少一个文件可用，批次即为 done。
      status: done > 0 ? "done" as const : "failed" as const,
      total_files: files.length,
      done_files: done,
      failed_files: files.length - done,
      files: results,
      created_at: createdAt.toISOString(),
      finished_at: new Date().toISOString(),
    };
  }

  private async process(file: Express.Multer.File, signal: AbortSignal) {
    const fileId = randomUUID();
    try {
      const bytes = file.buffer ?? await readFile(file.path, { signal });
      if (bytes.byteLength === 0) throw new Error("文件不能为空。");
      if (file.mimetype === "video/mp4" || file.originalname.toLowerCase().endsWith(".mp4")) {
        if (bytes.byteLength > this.config.MAX_VIDEO_BYTES) throw new Error("视频超过大小限制。");
        return await this.processVideo(fileId, file, bytes, signal);
      }
      if (bytes.byteLength > this.config.MAX_IMAGE_BYTES) throw new Error("图片超过20MB限制。");
      const image = sharp(bytes, { failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("图片格式无效，仅支持 JPG/JPEG、PNG、WebP。");
      const { width, height } = displayDimensions(metadata.width, metadata.height, metadata.orientation);
      // metadata 只读取文件头；stats 强制完整解码，避免截断/损坏图片被误判成功。
      if (signal.aborted) throw new HttpException("临时上传处理超过60秒。", 408);
      await image.stats();
      if (signal.aborted) throw new HttpException("临时上传处理超过60秒。", 408);
      const ext = metadata.format === "jpeg" ? "jpg" : metadata.format!;
      const stored = await this.zos.putTemporary(
        fileId,
        ext,
        bytes,
        metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
        signal,
      );
      return { file_id: fileId, file_name: file.originalname, status: "done" as const, media_url: stored.url, cover_url: stored.url, size_bytes: stored.size, width, height };
    } catch (error) {
      if (signal.aborted) throw new HttpException("临时上传处理超过60秒。", 408);
      return { file_id: fileId, file_name: file.originalname, status: "failed" as const, error: { code: "invalid_file", message: error instanceof Error ? error.message : "文件处理失败。" } };
    }
  }

  private async processVideo(fileId: string, file: Express.Multer.File, bytes: Buffer, signal: AbortSignal) {
    // MP4 的 ftyp box 位于文件头；MIME 仅用于快速提示，最终仍由 ffmpeg 解码校验。
    if (bytes.subarray(4, 12).toString("ascii").includes("ftyp") === false) throw new Error("视频不是有效 MP4。");
    const directory = await mkdtemp(path.join(tmpdir(), "assets-library-"));
    const source = path.join(directory, `${fileId}.mp4`);
    const cover = path.join(directory, `${fileId}.jpg`);
    try {
      await writeFile(source, bytes, { flag: "wx" });
      const duration = Number.parseFloat((await capture(this.config.FFPROBE_PATH, [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source,
      ], signal)).trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效。");
      await run(this.config.FFMPEG_PATH, ["-v", "error", "-y", "-i", source, "-frames:v", "1", "-q:v", "2", cover], signal);
      const coverBuffer = await readFile(cover);
      const probe = await sharp(coverBuffer).metadata();
      if (!probe.width || !probe.height) throw new Error("无法读取视频封面分辨率。");
      const coverDimensions = displayDimensions(probe.width, probe.height, probe.orientation);
      const uploaded = await Promise.allSettled([
        this.zos.putTemporary(fileId, "mp4", bytes, "video/mp4", signal),
        this.zos.putTemporary(`${fileId}-cover`, "jpg", coverBuffer, "image/jpeg", signal),
      ]);
      const mediaResult = uploaded[0];
      const thumbnailResult = uploaded[1];
      if (mediaResult.status === "rejected" || thumbnailResult.status === "rejected") {
        await Promise.allSettled(uploaded
          .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<ZosService["putTemporary"]>>> => result.status === "fulfilled")
          .map((result) => this.zos.delete(result.value.key)));
        if (mediaResult.status === "rejected") throw mediaResult.reason;
        if (thumbnailResult.status === "rejected") throw thumbnailResult.reason;
        throw new Error("视频或封面临时上传失败。");
      }
      const media = mediaResult.value;
      const thumbnail = thumbnailResult.value;
      return { file_id: fileId, file_name: file.originalname, status: "done" as const, media_url: media.url, cover_url: thumbnail.url, size_bytes: media.size, width: coverDimensions.width, height: coverDimensions.height, duration_seconds: duration };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
