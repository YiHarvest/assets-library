import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPreparedSceneBatch,
  prepareSceneBatch,
} from "@/server/scene/batch";
import { SceneDetectClient } from "@/server/scene/client";
import { ScenePipelineError } from "@/server/scene/types";

const execFileAsync = promisify(execFile);

async function createVideo(filePath: string, color = "blue", duration = 0.3) {
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=32x32:d=${duration}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    filePath,
  ]);
}

function manifest(
  taskId: string,
  sizes: number[],
  durationSeconds = sizes.length * 0.3,
) {
  return {
    taskId,
    originalFilename: "parent.mp4",
    durationSeconds,
    sceneCount: sizes.length,
    segments: sizes.map((sizeBytes, offset) => ({
      index: offset + 1,
      startSeconds: offset * 0.3,
      endSeconds: (offset + 1) * 0.3,
      durationSeconds: 0.3,
      startFrame: offset * 9,
      endFrame: (offset + 1) * 9,
      sizeBytes,
      filename: `segment-${String(offset + 1).padStart(3, "0")}.mp4`,
      downloadUrl: `/api/v1/videos/split/${taskId}/segments/${offset + 1}`,
    })),
  };
}

async function captureSceneError(
  operation: Promise<unknown>,
): Promise<ScenePipelineError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ScenePipelineError);
    return error as ScenePipelineError;
  }
  throw new Error("预期分镜操作失败，但操作成功完成。");
}

describe("scene video pipeline", () => {
  let directory: string;
  let parentPath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "asset-scenes-"));
    parentPath = path.join(directory, "parent.mp4");
    await createVideo(parentPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("downloads and fully validates every segment before exposing the batch", async () => {
    const first = path.join(directory, "first.mp4");
    const second = path.join(directory, "second.mp4");
    await Promise.all([
      createVideo(first, "red"),
      createVideo(second, "green"),
    ]);
    const bytes = [await fs.readFile(first), await fs.readFile(second)];
    const taskId = "a".repeat(32);
    const splitManifest = manifest(
      taskId,
      bytes.map((item) => item.byteLength),
    );
    const requested: string[] = [];
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/v1/videos/split" && init?.method === "POST") {
        // 异步队列：POST 立即返回任务 ID 与 queued 状态
        return Response.json({ taskId, status: "queued" }, { status: 202 });
      }
      if (url.pathname === `/api/v1/videos/split/${taskId}`) {
        // 状态轮询：第一次返回 queued，之后返回 done + 清单
        if (requested.filter((item) => item === `GET ${url.pathname}`).length <= 1) {
          return Response.json({ taskId, status: "queued" });
        }
        return Response.json({ ...splitManifest, status: "done" });
      }
      const match = url.pathname.match(/\/segments\/(\d+)$/);
      if (match) {
        return new Response(bytes[Number(match[1]) - 1], {
          headers: { "content-type": "video/mp4" },
        });
      }
      if (url.pathname.endsWith(taskId) && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const client = new SceneDetectClient({
      baseUrl: "http://127.0.0.1:28200",
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      fetchImplementation: fakeFetch,
    });

    const batch = await prepareSceneBatch({
      client,
      normalizedParentPath: parentPath,
      originalFilename: "parent.mp4",
      workspaceRoot: path.join(directory, "workspace"),
      maximumSegmentBytes: 10 * 1024 * 1024,
    });

    expect(batch.segments).toHaveLength(2);
    expect(batch.segments.map((segment) => segment.sizeBytes)).toEqual(
      bytes.map((item) => item.byteLength),
    );
    await Promise.all(
      batch.segments.map((segment) => expect(fs.stat(segment.absolutePath)).resolves.toBeTruthy()),
    );
    await Promise.all(
      batch.segments.map(async (segment) => {
        const thumbnail = await fs.readFile(segment.thumbnailAbsolutePath);
        expect(segment.thumbnailSizeBytes).toBe(thumbnail.byteLength);
        expect([...thumbnail.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      }),
    );
    await Promise.all(
      batch.segments.map(async (segment) => {
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(segment.analysisFramesDirectory, "manifest.json"),
            "utf8",
          ),
        ) as { frames: Array<{ filename: string }> };
        expect(manifest.frames).toHaveLength(1);
        const frame = await fs.readFile(
          path.join(
            segment.analysisFramesDirectory,
            manifest.frames[0]!.filename,
          ),
        );
        expect([...frame.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      }),
    );
    expect(requested).not.toContain(`DELETE /api/v1/videos/split/${taskId}`);

    await cleanupPreparedSceneBatch(batch, client);
    await expect(fs.stat(batch.workspacePath)).rejects.toThrow();
    expect(requested).toContain(`DELETE /api/v1/videos/split/${taskId}`);
  }, 20_000);

  it("re-splits an oversized manifest segment locally from the parent", async () => {
    const taskId = "b".repeat(32);
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/videos/split" && init?.method === "POST") {
        return Response.json({ taskId, status: "queued" }, { status: 202 });
      }
      if (url.pathname === `/api/v1/videos/split/${taskId}`) {
        return Response.json({
          ...manifest(taskId, [10 * 1024 * 1024 + 1]),
          status: "done",
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("切片不应被下载");
    });
    const client = new SceneDetectClient({
      baseUrl: "http://127.0.0.1:28200",
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      fetchImplementation: fakeFetch,
    });

    const batch = await prepareSceneBatch({
      client,
      normalizedParentPath: parentPath,
      originalFilename: "parent.mp4",
      workspaceRoot: path.join(directory, "workspace"),
      maximumSegmentBytes: 10 * 1024 * 1024,
    });

    expect(batch.resplitCount).toBe(1);
    expect(batch.resplitDetails).toEqual([
      {
        segmentIndex: 1,
        startSeconds: 0,
        endSeconds: 0.3,
        actualBytes: expect.any(Number),
        maximumBytes: 10 * 1024 * 1024,
      },
    ]);
    expect(batch.segments).toHaveLength(1);
    expect(batch.segments[0]!.sizeBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    await expect(fs.stat(batch.segments[0]!.absolutePath)).resolves.toBeTruthy();
    expect(
      fakeFetch.mock.calls.filter(([input]) =>
        String(input).match(/\/segments\/\d+$/),
      ),
    ).toHaveLength(0);

    await cleanupPreparedSceneBatch(batch, client);
    await expect(fs.stat(batch.workspacePath)).rejects.toThrow();
  }, 20_000);

  it("removes the complete local batch when any downloaded segment is corrupt", async () => {
    const validPath = path.join(directory, "valid.mp4");
    await createVideo(validPath, "yellow");
    const valid = await fs.readFile(validPath);
    const corrupt = Buffer.from("not a video");
    const taskId = "c".repeat(32);
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/videos/split" && init?.method === "POST") {
        return Response.json({ taskId, status: "queued" }, { status: 202 });
      }
      if (url.pathname === `/api/v1/videos/split/${taskId}`) {
        return Response.json({
          ...manifest(taskId, [valid.length, corrupt.length]),
          status: "done",
        });
      }
      if (url.pathname.endsWith("/segments/1")) return new Response(valid);
      if (url.pathname.endsWith("/segments/2")) return new Response(corrupt);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    const client = new SceneDetectClient({
      baseUrl: "http://127.0.0.1:28200",
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      fetchImplementation: fakeFetch,
    });

    const error = await captureSceneError(
      prepareSceneBatch({
        client,
        normalizedParentPath: parentPath,
        originalFilename: "parent.mp4",
        workspaceRoot: path.join(directory, "workspace"),
        maximumSegmentBytes: 10 * 1024 * 1024,
      }),
    );

    expect(error.code).toBe("scene_segment_invalid");
    expect(error.details.segments).toEqual([
      expect.objectContaining({ segmentIndex: 2 }),
    ]);
    expect(fakeFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: `/api/v1/videos/split/${taskId}` }),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(await fs.readdir(path.join(directory, "workspace"))).toEqual([]);
  }, 20_000);

  it("accepts the legacy synchronous 200 manifest during a rolling deployment", async () => {
    const taskId = "d".repeat(32);
    const splitManifest = manifest(taskId, [1_024]);
    const fakeFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      return Response.json(splitManifest, { status: 200 });
    });
    const client = new SceneDetectClient({
      baseUrl: "http://127.0.0.1:28200",
      timeoutMs: 10_000,
      fetchImplementation: fakeFetch,
    });

    await expect(
      client.splitVideo(parentPath, "parent.mp4"),
    ).resolves.toEqual(splitManifest);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("deletes an asynchronous remote task when scene processing fails", async () => {
    const taskId = "e".repeat(32);
    const requested: string[] = [];
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/split") && init?.method === "POST") {
        return Response.json({ taskId, status: "queued" }, { status: 202 });
      }
      if (url.pathname.endsWith(taskId) && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        taskId,
        status: "failed",
        error: { code: "video_split_failed", message: "ffmpeg failed" },
      });
    });
    const client = new SceneDetectClient({
      baseUrl: "http://127.0.0.1:28200",
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      fetchImplementation: fakeFetch,
    });

    const error = await captureSceneError(
      client.splitVideo(parentPath, "parent.mp4"),
    );

    expect(error.code).toBe("scene_detection_failed");
    expect(requested).toContain(`DELETE /api/v1/videos/split/${taskId}`);
  });
});
