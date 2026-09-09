import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";

const execFileAsync = promisify(execFile);
let nvencProbe: Promise<boolean> | undefined;

/** CPU 处理输入、滤镜和音频，NVENC 可用时承担 H.264 编码；auto 允许 CPU 兜底。 */
export async function runH264Encode(
  args: string[],
  outputPath: string,
  failure: AppError,
  stillImage = false,
) {
  const mode = loadConfig().FFMPEG_HW_ACCEL;
  let useGpu = mode === "cuda";
  if (mode === "auto") {
    // 编码器列表不能证明驱动/API 兼容，实际编码一帧并共享本进程的探测结果。
    nvencProbe ??= runMediaCommand("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:size=320x240:rate=1",
      "-frames:v", "1", "-c:v", "h264_nvenc", "-preset", "p4", "-f", "null", "-",
    ], failure, 10_000).then(() => true, () => false);
    useGpu = await nvencProbe;
  }
  const encode = (gpu: boolean) => runMediaCommand("ffmpeg", [
    ...args,
    ...(gpu
      ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", ...(stillImage ? ["-tune", "stillimage"] : [])]),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", outputPath,
  ], failure);
  try {
    return await encode(useGpu);
  } catch (error) {
    if (!useGpu || mode !== "auto") throw error;
    // 当前输入不受 GPU 支持或设备繁忙时，删除半成品再用 CPU 重试。
    await fs.rm(outputPath, { force: true });
    return encode(false);
  }
}

type MediaCommandError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals;
};

export async function runMediaCommand(
  command: "ffmpeg" | "ffprobe",
  args: string[],
  failure: AppError,
  timeoutMs = 60_000,
) {
  try {
    return await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const commandError = error as MediaCommandError;
    if (commandError.code === "ENOENT" || commandError.code === "EACCES") {
      throw new AppError(
        "internal_error",
        "服务端媒体处理工具不可用，请联系管理员。",
        500,
      );
    }
    if (
      commandError.killed ||
      commandError.signal ||
      commandError.code === "ETIMEDOUT"
    ) {
      throw new AppError(
        "internal_error",
        "媒体处理超时，请稍后重试或上传较短的文件。",
        500,
      );
    }
    throw failure;
  }
}
