import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "mysql://test:test@127.0.0.1:3306/assets";
process.env.ZOS_API_ENDPOINT = "http://127.0.0.1:9000";
process.env.ZOS_BUCKET = "test";
process.env.ZOS_ACCESS_KEY_ID = "test";
process.env.ZOS_SECRET_ACCESS_KEY = "test";
process.env.ZOS_WEB_URL = "http://127.0.0.1:9000";
process.env.TEMP_UPLOAD_AUDIT_SALT = "0123456789abcdef0123456789abcdef";
process.env.SCENE_DETECT_BASE_URL = "http://127.0.0.1:28200";
process.env.SCENE_DETECT_TIMEOUT_MS = "5000";
process.env.SCENE_DETECT_POLL_INTERVAL_MS = "200";

const taskId = "0123456789abcdef0123456789abcdef";

test("分镜客户端提交202任务、轮询完成，并在失败时取消远端任务", async () => {
  const { SceneClient } = await import("../src/scene/scene.client");
  const originalFetch = globalThis.fetch;
  let mode: "success" | "failed" = "success";
  let polls = 0;
  let deletes = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (init?.method === "POST") {
      return Response.json({ taskId, status: "queued" }, { status: 202 });
    }
    if (init?.method === "DELETE") {
      deletes += 1;
      return new Response(null, { status: 204 });
    }
    polls += 1;
    if (mode === "failed") {
      return Response.json({
        taskId,
        status: "failed",
        error: { code: "scene_detection_failed", message: "ffmpeg failed" },
      });
    }
    if (polls === 1) return Response.json({ taskId, status: "processing" });
    return Response.json({
      taskId,
      status: "done",
      originalFilename: "video.mp4",
      durationSeconds: 1,
      sceneCount: 1,
      segments: [{
        index: 1,
        startSeconds: 0,
        endSeconds: 1,
        durationSeconds: 1,
        sizeBytes: 1024,
        filename: "segment-001.mp4",
        downloadUrl: `/api/v1/videos/split/${taskId}/segments/1`,
      }],
    });
  }) as typeof fetch;

  try {
    const client = new SceneClient();
    const manifest = await client.split(Buffer.from("video"), "video.mp4");
    assert.equal(manifest.taskId, taskId);
    assert.equal(manifest.segments.length, 1);
    assert.equal(deletes, 0, "成功任务的切片仍需供下游下载，不能立即删除");

    mode = "failed";
    polls = 0;
    await assert.rejects(client.split(Buffer.from("video"), "video.mp4"), /ffmpeg failed/);
    assert.equal(deletes, 1, "失败任务应触发远端清理，避免半成品泄漏");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
