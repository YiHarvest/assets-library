import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/errors";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), rm: vi.fn(), mode: "auto" }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ default: { rm: mocks.rm } }));
vi.mock("@/server/config", () => ({ loadConfig: () => ({ FFMPEG_HW_ACCEL: mocks.mode }) }));

const failure = new AppError("storage_error", "encoding failed", 500);
const input = ["-i", "source.mp4", "-t", "1.48", "-vf", "fps=30", "-frames:v", "44"];
type Done = (error: Error | null, output?: { stdout: string; stderr: string }) => void;

function simulate(fails: (args: string[]) => boolean = () => false) {
  mocks.execFile.mockImplementation((_command: string, args: string[], _options: unknown, done: Done) => {
    queueMicrotask(() => done(fails(args) ? new Error("encoder unavailable") : null, { stdout: "", stderr: "" }));
  });
}

describe("asynchronous H.264 encoding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.mode = "auto";
    mocks.rm.mockResolvedValue(undefined);
    simulate();
  });

  it("uses CPU only without probing when hardware acceleration is disabled", async () => {
    mocks.mode = "none";
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await runH264Encode(input, "clip.mp4", failure);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0][1]).toEqual(expect.arrayContaining(["libx264", ...input]));
  });

  it("shares one actual NVENC probe and uses GPU for concurrent video and image encoding", async () => {
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await Promise.all([runH264Encode(input, "clip.mp4", failure), runH264Encode(["-loop", "1", "-i", "still.png", "-t", "3"], "still.mp4", failure, true)]);
    const calls = mocks.execFile.mock.calls.map(call => call[1] as string[]);
    expect(calls).toHaveLength(3);
    expect(calls.filter(args => args.includes("lavfi"))).toHaveLength(1);
    expect(calls.every(args => args.includes("h264_nvenc"))).toBe(true);
    expect(calls.every(args => !args.includes("stillimage"))).toBe(true);
  });

  it("uses CPU when the installed driver fails the actual NVENC probe", async () => {
    simulate(args => args.includes("h264_nvenc"));
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await runH264Encode(input, "first.mp4", failure);
    await runH264Encode(input, "second.mp4", failure);
    const calls = mocks.execFile.mock.calls.map(call => call[1] as string[]);
    expect(calls.filter(args => args.includes("h264_nvenc"))).toHaveLength(1);
    expect(calls.filter(args => args.includes("libx264"))).toHaveLength(2);
  });

  it("removes a failed GPU output before CPU retry and preserves still-image tuning", async () => {
    simulate(args => args.includes("h264_nvenc") && !args.includes("lavfi"));
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await runH264Encode(["-loop", "1", "-i", "still.png", "-t", "3"], "still.mp4", failure, true);
    expect(mocks.rm).toHaveBeenCalledWith("still.mp4", { force: true });
    expect(mocks.rm.mock.invocationCallOrder[0]).toBeLessThan(mocks.execFile.mock.invocationCallOrder[2]);
    expect(mocks.execFile.mock.calls[2][1]).toEqual(expect.arrayContaining(["libx264", "stillimage", "-t", "3"]));
  });

  it("reports failure without CPU fallback when CUDA is explicitly required", async () => {
    mocks.mode = "cuda";
    simulate(() => true);
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await expect(runH264Encode(input, "clip.mp4", failure)).rejects.toBe(failure);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0][1]).toContain("h264_nvenc");
  });

  it("propagates CPU failure after an unsuccessful GPU attempt", async () => {
    simulate(args => !args.includes("lavfi"));
    const { runH264Encode } = await import("@/server/media/ffmpeg");
    await expect(runH264Encode(input, "clip.mp4", failure)).rejects.toBe(failure);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });
});
