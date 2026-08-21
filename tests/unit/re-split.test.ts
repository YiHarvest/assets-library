import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mediaCommand = vi.hoisted(() => vi.fn());

vi.mock("@/server/media/ffmpeg", () => ({ runMediaCommand: mediaCommand }));

import { resplitSegment } from "@/server/scene/re-split";

describe("video size re-splitting", () => {
  let workspace: string | undefined;

  afterEach(async () => {
    mediaCommand.mockReset();
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
  });

  it("rejects a minimum-duration tail that still exceeds the byte limit", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "resplit-limit-"));
    const maximumBytes = 1_024;
    mediaCommand.mockImplementation(
      async (command: string, arguments_: string[]) => {
        if (command === "ffprobe") return { stdout: "N/A\n", stderr: "" };
        await fs.writeFile(arguments_.at(-1)!, Buffer.alloc(maximumBytes + 1));
        return { stdout: "", stderr: "" };
      },
    );

    const operation = resplitSegment(
      path.join(workspace, "parent.mp4"),
      0,
      0.1,
      maximumBytes,
      workspace,
    );

    await expect(operation).rejects.toMatchObject({
      code: "corrupt_file",
      details: { actualBytes: maximumBytes + 1, maximumBytes },
    });
    await expect(fs.stat(path.join(workspace, ".resplit"))).rejects.toThrow();
  });
});
