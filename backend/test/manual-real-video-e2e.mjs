import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const apiBase = process.env.E2E_API_BASE ?? "http://127.0.0.1:23017/api/v1";
const videoPath = process.argv[2];
const userId = process.env.E2E_USER_ID ?? `codex-e2e-video-${Date.now()}`;
const autoPublish = process.env.E2E_AUTO_PUBLISH === "true";

if (!videoPath) {
  throw new Error("usage: node backend/test/manual-real-video-e2e.mjs <video.mp4>");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { expected = [200], ...init } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path}: expected ${expected.join("/")}, got ${response.status}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, body };
}

async function waitTask(taskId, terminal = ["done", "pending_review", "failed"], timeoutMs = 15 * 60_000) {
  const started = Date.now();
  let previous = "";
  while (Date.now() - started < timeoutMs) {
    const { body } = await request(`/tasks?task_id=${encodeURIComponent(taskId)}`);
    const state = `${body.status}/${body.phase}`;
    if (state !== previous) {
      console.log(`task ${taskId}: ${state}`);
      previous = state;
    }
    if (terminal.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`task ${taskId} timed out`);
}

async function assertUrlReadable(url, label) {
  assert(typeof url === "string" && url.startsWith("http"), `${label} missing`);
  const head = await fetch(url, { method: "HEAD" });
  assert(head.ok, `${label} HEAD failed: HTTP ${head.status}`);
  const range = await fetch(url, { headers: { range: "bytes=0-0" } });
  assert([200, 206].includes(range.status), `${label} Range GET failed: HTTP ${range.status}`);
  await range.body?.cancel();
}

async function assertMp4Playable(url) {
  const response = await fetch(url);
  assert(response.ok, `MP4 download failed: HTTP ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "assets-video-e2e-"));
  const file = join(directory, "slice.mp4");
  try {
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name", "-of", "csv=p=0", file,
    ]);
    assert(stdout.trim().length > 0, "ffprobe found no playable video stream");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.env.E2E_CLEANUP_FILE_ID) {
  const fileId = process.env.E2E_CLEANUP_FILE_ID;
  const owner = process.env.E2E_CLEANUP_OWNER ?? null;
  if (owner) {
    const { body: softDelete } = await request("/assets/delete", {
      method: "DELETE",
      expected: [202],
      body: JSON.stringify({ file_id: fileId, user_id: owner }),
    });
    await waitTask(softDelete.task_id);
  }
  const { body: hardDelete } = await request("/assets/delete", {
    method: "DELETE",
    expected: [202],
    body: JSON.stringify({ file_id: fileId, user_id: null }),
  });
  await waitTask(hardDelete.task_id);
  await request(`/assets/detail?file_id=${fileId}`, { expected: [404] });
  console.log(`cleanup_file_id=${fileId}`);
  process.exit(0);
}

if (process.env.E2E_CLEANUP_TASK_ID) {
  const owner = process.env.E2E_CLEANUP_OWNER ?? null;
  const { body: task } = await request(`/tasks?task_id=${encodeURIComponent(process.env.E2E_CLEANUP_TASK_ID)}`);
  const slices = task.files?.flatMap((file) => file.slices ?? []) ?? [];
  for (const slice of slices) {
    if (slice.phase !== "published") {
      const { body: publish } = await request("/assets/publish", {
        method: "POST",
        expected: [202],
        body: JSON.stringify({ file_id: slice.file_id, user_id: owner }),
      });
      await waitTask(publish.task_id);
    }
    const { body: softDelete } = await request("/assets/delete", {
      method: "DELETE",
      expected: [202],
      body: JSON.stringify({ file_id: slice.file_id, user_id: owner }),
    });
    await waitTask(softDelete.task_id);
    const { body: hardDelete } = await request("/assets/delete", {
      method: "DELETE",
      expected: [202],
      body: JSON.stringify({ file_id: slice.file_id, user_id: null }),
    });
    await waitTask(hardDelete.task_id);
  }
  console.log(`cleanup_task_id=${process.env.E2E_CLEANUP_TASK_ID} slices=${slices.length}`);
  process.exit(0);
}

const videoBytes = await readFile(videoPath);
const randomId = crypto.randomUUID();
const createdIds = { uploadTaskId: null, sourceId: null, sliceId: null };
const { body: usageBefore } = await request("/storage/usage", {
  method: "POST",
  body: JSON.stringify({ user_id: userId }),
});

console.log(`user_id=${userId}`);
console.log(`video_bytes=${videoBytes.byteLength}`);

await request("/uploads", {
  method: "POST",
  expected: [400],
  body: JSON.stringify({
    user_id: userId,
    auto_publish: autoPublish,
    files: [
      { media_type: "video", file_name: "bad.mp4" },
      { media_type: "image", file_name: "bad.jpg" },
    ],
  }),
});
await request("/uploads/complete", {
  method: "POST",
  expected: [404],
  body: JSON.stringify({ task_id: randomId }),
});
await request(`/assets/detail?file_id=${randomId}`, { expected: [404] });
await request("/assets/publish", {
  method: "POST",
  expected: [404],
  body: JSON.stringify({ file_id: randomId, user_id: userId }),
});
await request("/assets/delete", {
  method: "DELETE",
  expected: [400],
  body: JSON.stringify({ file_id: randomId, video_source_id: randomId, user_id: userId }),
});
console.log("negative_cases=passed");

const { body: created } = await request("/uploads", {
  method: "POST",
  expected: [201],
  body: JSON.stringify({
    user_id: userId,
    auto_publish: autoPublish,
    files: [{ media_type: "video", file_name: `e2e-video-${Date.now()}.mp4` }],
  }),
});
assert(created.files?.length === 1, "create response must contain exactly one target");
assert(created.files[0].video_source_id, "video_source_id missing");
assert(created.files[0].upload_url, "upload_url missing");
createdIds.uploadTaskId = created.task_id;
createdIds.sourceId = created.files[0].video_source_id;
console.log(`created task_id=${created.task_id} video_source_id=${createdIds.sourceId}`);

const put = await fetch(created.files[0].upload_url, {
  method: "PUT",
  body: videoBytes,
  headers: { "content-type": "video/mp4" },
});
assert(put.ok, `ZOS PUT failed: HTTP ${put.status}`);
await put.body?.cancel();
console.log(`zos_put_status=${put.status}`);

const { body: afterComplete } = await request("/uploads/complete", {
  method: "POST",
  expected: [202],
  body: JSON.stringify({ task_id: created.task_id }),
});
assert(afterComplete.video_source_id === undefined, "top-level video_source_id is not part of task contract");

const processed = await waitTask(created.task_id);
assert(
  processed.status === (autoPublish ? "done" : "pending_review"),
  `video processing failed: ${JSON.stringify(processed.error ?? processed.files?.[0]?.error ?? {})}`,
);
const slices = processed.files?.[0]?.slices ?? [];
assert(slices.length > 0, "video processing produced no slices");
for (const slice of slices) {
  assert(slice.video_source_id === createdIds.sourceId, "slice video_source_id mismatch");
  await assertUrlReadable(slice.media_url, "slice media_url");
  await assertUrlReadable(slice.cover_url, "slice cover_url");
}
await assertMp4Playable(slices[0].media_url);
createdIds.sliceId = slices[0].file_id;
console.log(`processed_slices=${slices.length} first_slice_id=${createdIds.sliceId}`);

if (!autoPublish) {
  const { body: pending } = await request(`/tasks?view=pending&user_id=${encodeURIComponent(userId)}&limit=100`);
  assert(pending.tasks.some((task) => task.task_id === created.task_id), "upload task missing from the user's pending task list");
}

if (autoPublish) {
  assert(slices.every((slice) => slice.status === "done" && slice.phase === "published"), "auto publish did not publish every slice");
  const { body: detail } = await request(`/assets/detail?file_id=${createdIds.sliceId}`);
  assert(detail.user_id === userId && detail.video_source_id === createdIds.sourceId, "auto-published detail ownership/source mismatch");
  await assertUrlReadable(detail.media_url, "auto-published media_url");
  await assertUrlReadable(detail.cover_url, "auto-published cover_url");
  const { body: list } = await request("/assets/list", {
    method: "POST",
    body: JSON.stringify({ user_id: userId, media_type: "video", phases: ["published"], limit: 100 }),
  });
  assert(slices.every((slice) => list.files.some((file) => file.file_id === slice.file_id)), "auto-published slice missing from list");
  for (const slice of slices) {
    const { body: softDelete } = await request("/assets/delete", {
      method: "DELETE",
      expected: [202],
      body: JSON.stringify({ file_id: slice.file_id, user_id: userId }),
    });
    await waitTask(softDelete.task_id);
    const { body: hardDelete } = await request("/assets/delete", {
      method: "DELETE",
      expected: [202],
      body: JSON.stringify({ file_id: slice.file_id, user_id: null }),
    });
    await waitTask(hardDelete.task_id);
  }
  console.log(JSON.stringify({ ok: true, auto_publish: true, user_id: userId, ...createdIds, slices: slices.length }));
  process.exit(0);
}

await request(`/assets/detail?file_id=${createdIds.sliceId}`, { expected: [404] });
await request("/assets/delete", {
  method: "DELETE",
  expected: [409],
  body: JSON.stringify({ video_source_id: createdIds.sourceId, user_id: userId }),
});
console.log("pending_parent_delete_rejected=passed");
await request("/assets/publish", {
  method: "POST",
  expected: [403],
  body: JSON.stringify({ file_id: createdIds.sliceId, user_id: `${userId}-wrong` }),
});

const { body: publishQueued } = await request("/assets/publish", {
  method: "POST",
  expected: [202],
  body: JSON.stringify({ file_id: createdIds.sliceId, user_id: userId }),
});
const publishDone = await waitTask(publishQueued.task_id);
assert(publishDone.status === "done" && publishDone.phase === "published", "publish task did not complete");

const { body: detail } = await request(`/assets/detail?file_id=${createdIds.sliceId}`);
assert(detail.file_id === createdIds.sliceId, "detail file_id mismatch");
assert(detail.video_source_id === createdIds.sourceId, "detail video_source_id mismatch");
assert(detail.user_id === userId, "detail user_id mismatch");
assert(detail.media_type === "video", "detail media_type mismatch");
await assertUrlReadable(detail.media_url, "published media_url");
await assertUrlReadable(detail.cover_url, "published cover_url");
console.log("publish_detail_urls=passed");

const { body: personalList } = await request("/assets/list", {
  method: "POST",
  body: JSON.stringify({ user_id: userId, media_type: "video", phases: ["published"], limit: 100 }),
});
assert(personalList.files.some((file) => file.file_id === createdIds.sliceId), "published slice missing from personal list");
const { body: usageAfterPublish } = await request("/storage/usage", {
  method: "POST",
  body: JSON.stringify({ user_id: userId }),
});
assert(usageAfterPublish.video_files >= usageBefore.video_files + 1, "storage usage did not include the published slice");
assert(usageAfterPublish.video_bytes > usageBefore.video_bytes, "storage usage video bytes did not increase");

await request("/assets/delete", {
  method: "DELETE",
  expected: [403],
  body: JSON.stringify({ file_id: createdIds.sliceId, user_id: `${userId}-wrong` }),
});
const { body: softDeleteQueued } = await request("/assets/delete", {
  method: "DELETE",
  expected: [202],
  body: JSON.stringify({ file_id: createdIds.sliceId, user_id: userId }),
});
const softDeleteDone = await waitTask(softDeleteQueued.task_id);
assert(softDeleteDone.status === "done", "soft delete did not complete");
const { body: publicDetail } = await request(`/assets/detail?file_id=${createdIds.sliceId}`);
assert(publicDetail.user_id === null, "soft-deleted personal asset did not become public");
console.log("soft_delete_to_public=passed");

const { body: hardDeleteQueued } = await request("/assets/delete", {
  method: "DELETE",
  expected: [202],
  body: JSON.stringify({ file_id: createdIds.sliceId, user_id: null }),
});
const hardDeleteDone = await waitTask(hardDeleteQueued.task_id);
assert(hardDeleteDone.status === "done" && hardDeleteDone.phase === "expired", "hard delete did not expire asset");
await request(`/assets/detail?file_id=${createdIds.sliceId}`, { expected: [404] });
console.log("hard_delete=passed");

const remaining = slices.slice(1);
if (remaining.length > 0) {
  const pendingList = await request(`/tasks?view=pending&user_id=${encodeURIComponent(userId)}&limit=100`);
  assert(pendingList.body.tasks.some((task) => task.task_id === created.task_id), "remaining pending video task missing from pending list");
  await request("/assets/delete", {
    method: "DELETE",
    expected: [409],
    body: JSON.stringify({ video_source_id: createdIds.sourceId, user_id: userId }),
  });
} else {
  await request("/assets/delete", {
    method: "DELETE",
    expected: [409],
    body: JSON.stringify({ video_source_id: createdIds.sourceId, user_id: userId }),
  });
}

console.log(JSON.stringify({ ok: true, user_id: userId, ...createdIds, remaining_pending_slices: remaining.length }));
