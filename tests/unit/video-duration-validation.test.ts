import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/errors";
import { validateVideoFile } from "@/server/media/video-validation";

const command = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/ffmpeg", () => ({ runMediaCommand: command }));

describe("normalized video duration", () => {
  let directory: string;
  let source: string;
  let header: [number, number];
  let decoded: [number | null, number | null];
  let corruptOutput: boolean;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "video-duration-"));
    source = path.join(directory, "source.mp4");
    await fs.writeFile(source, "original");
    header = [15.063807, 15.266667];
    decoded = [15.266667, 15.266667];
    corruptOutput = false;
    command.mockImplementation(async (tool: string, args: string[], failure: AppError) => {
      if (tool === "ffprobe") {
        const index = args.at(-1) === source ? 0 : 1;
        return { stdout: JSON.stringify({
          format: { format_name: "mov", tags: { major_brand: "isom" } },
          streams: [{ codec_type: "video", codec_name: index ? "h264" : "hevc",
            pix_fmt: "yuv420p", width: 16, height: 16, duration: String(header[index]) }],
        }) };
      }
      if (args.includes("null")) {
        const index = args[args.indexOf("-i") + 1] === source ? 0 : 1;
        if (index && corruptOutput) throw failure;
        const micros = decoded[index] === null ? "N/A" : Math.round(decoded[index] * 1_000_000);
        return { stdout: `out_time_us=100000\nprogress=continue\nout_time_us=${micros}\nprogress=end\n` };
      }
      await fs.writeFile(args.at(-1)!, "normalized");
      return { stdout: "" };
    });
  });

  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  const validate = () => validateVideoFile(source,
    { mediaType: "video", mimeType: "video/mp4", extension: ".mp4" }, 8, 1_000_000);

  it("accepts all decoded frames when the source header omits a timestamp gap", async () => {
    await expect(validate()).resolves.toMatchObject({ mediaType: "video", sizeBytes: 10 });
    expect(await fs.readFile(source, "utf8")).toBe("normalized");
  });

  it.each([true, false])("rejects shortened output even when headers agree: %s", async (sameHeaders) => {
    header = [15, sameHeaders ? 15 : 14];
    decoded = [15, 14];
    await expect(validate()).rejects.toMatchObject({ code: "corrupt_file" });
    expect(await fs.readFile(source, "utf8")).toBe("original");
  });

  it("does not accept a header mismatch from an incomplete decode timestamp", async () => {
    decoded = [null, null];
    await expect(validate()).rejects.toMatchObject({ code: "corrupt_file" });
  });

  it("still rejects output that fails strict decoding", async () => {
    corruptOutput = true;
    await expect(validate()).rejects.toMatchObject({ code: "corrupt_file" });
    expect(await fs.readFile(source, "utf8")).toBe("original");
  });
});
