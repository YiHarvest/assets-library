import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultApiV1Service } from "@/server/api/v1/default-service";
import type { ApiV1Service } from "@/server/api/v1/service";
import { installApiV1Service } from "@/server/api/v1/service";
import {
  createUploadTaskSchema,
  MAX_UPLOAD_TASK_BYTES,
  MAX_UPLOAD_TASK_ITEMS,
  type ApiV1AssetDetail,
  type TaskStatusResponse,
} from "@/shared/contracts";
import { POST as createUpload } from "@/app/api/v1/uploads/route";
import { PUT as receiveUploadItem } from "@/app/api/v1/uploads/[taskId]/items/[itemId]/route";
import { POST as sealUploadTask } from "@/app/api/v1/uploads/[taskId]/route";
import { GET as getTask } from "@/app/api/v1/tasks/[taskId]/route";
import { POST as queryAssets } from "@/app/api/v1/assets/query/route";
import { POST as createCompatibilityMatch } from "@/app/api/v1/compat/segment-match/route";
import {
  DELETE as deleteAsset,
  GET as getAsset,
  PATCH as updateAsset,
} from "@/app/api/v1/assets/[assetId]/route";
import { POST as publishAsset } from "@/app/api/v1/assets/[assetId]/publish/route";
import { POST as retryAsset } from "@/app/api/v1/assets/[assetId]/retry/route";
import { GET as getMedia } from "@/app/api/v1/media/[assetId]/route";
import { GET as getThumbnail } from "@/app/api/v1/media/[assetId]/thumbnail/route";
import { GET as getUserMedia } from "@/app/api/v1/users/[userId]/media/route";
import { GET as getUserStorageUsage } from "@/app/api/v1/users/[userId]/storage-usage/route";
import { GET as getOpenApi } from "@/app/api/v1/openapi/route";
import { GET as getWebUiUsers } from "@/app/api/webui/users/route";

const taskId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const now = "2026-08-12T12:00:00+08:00";

const asset: ApiV1AssetDetail = {
  asset_id: assetId,
  parent_video_id: null,
  segment_index: null,
  user_id: "user-7",
  name: "demo",
  description: "demo asset",
  media_type: "image",
  status: "done",
  review_status: "published",
  tags: [{ category: "scene", value: "office" }],
  media_url: `/api/v1/media/${assetId}`,
  original_filename: "demo.png",
  mime_type: "image/png",
  size_bytes: 3,
  segment_start_seconds: null,
  segment_end_seconds: null,
  failure: null,
  analysis: null,
  created_at: now,
  updated_at: now,
};

function task(
  overrides: Partial<TaskStatusResponse> = {},
): TaskStatusResponse {
  return {
    task_id: taskId,
    task_type: "upload",
    status: "queued",
    phase: "receiving",
    progress_percent: 0,
    received_bytes: 0,
    total_bytes: 3,
    total_items: 1,
    done_items: 0,
    failed_items: 0,
    callback_url: null,
    result: null,
    items: [
      {
        item_id: itemId,
        filename: "demo.png",
        media_type: "image",
        status: "queued",
        phase: "receiving",
        received_bytes: 0,
        total_bytes: 3,
        progress_percent: 0,
        private_asset_ids: [],
        public_asset_ids: [],
        error: null,
      },
    ],
    error: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    expires_at: null,
    ...overrides,
  };
}

function fakeService() {
  return {
    createCompatibilityMatchTask: vi.fn(async () => ({
      taskId,
      status: "processing" as const,
    })),
    createUploadTask: vi.fn(async () => task()),
    receiveUploadItem: vi.fn(async () =>
      task({ received_bytes: 3, progress_percent: 100 }),
    ),
    sealUploadTask: vi.fn(async () => task()),
    getTask: vi.fn(async () => task()),
  queryAssets: vi.fn(async () => ({
    items: [],
    next_cursor: null,
    has_more: false,
    tag_statistics: null,
    search: null,
  })),
    getUserStorageUsage: vi.fn(async (userId: string) => ({
      user_id: userId,
      total_files: 2,
      image_files: 1,
      video_files: 1,
      total_bytes: 18,
      image_bytes: 3,
      video_bytes: 15,
      items: [
        {
          asset_id: assetId,
          name: "demo",
          media_type: "image" as const,
          media_bytes: 3,
          thumbnail_bytes: 0,
          total_bytes: 3,
        },
      ],
    })),
    listUserMedia: vi.fn(async (userId: string) => ({
      user_id: userId,
      items: [
        {
          asset_id: assetId,
          name: "demo",
          media_type: "image" as const,
          size_bytes: 3,
          media_url: `http://localhost/api/v1/media/${assetId}?user_id=${userId}`,
          created_at: now,
        },
      ],
      next_cursor: null,
      has_more: false,
    })),
    getAsset: vi.fn(async () => asset),
    listUsers: vi.fn(async () => [
      {
        user_id: "user-7",
        display_name: null,
        email: null,
        department: null,
        first_seen_at: now,
        last_seen_at: now,
        asset_count: 1,
      },
      {
        user_id: "user-8",
        display_name: "用户 8",
        email: "user-8@example.com",
        department: "剪辑",
        first_seen_at: now,
        last_seen_at: now,
        asset_count: 3,
      },
    ]),
    updateAsset: vi.fn(async () =>
      task({ task_type: "update", phase: "updating" }),
    ),
    publishAsset: vi.fn(async () =>
      task({ task_type: "publish", phase: "publishing" }),
    ),
    retryAsset: vi.fn(async () =>
      task({ task_type: "retry", phase: "retrying" }),
    ),
    deleteAsset: vi.fn(async () =>
      task({ task_type: "delete", phase: "deleting" }),
    ),
    listTasks: vi.fn(async () => ({
      items: [],
      next_cursor: null,
      has_more: false,
    })),
    getMedia: vi.fn(async () =>
      new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-length": "3",
          "content-range": "bytes 2-4/10",
          "accept-ranges": "bytes",
        },
      }),
    ),
    getThumbnail: vi.fn(async () =>
      new Response(new Uint8Array([9]), {
        headers: { "content-type": "image/jpeg", "content-length": "1" },
      }),
    ),
  } satisfies ApiV1Service;
}

function jsonRequest(
  url: string,
  body: unknown,
  method = "POST",
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("API v1 contracts and routes", () => {
  afterEach(() => {
    installApiV1Service(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("normalizes an empty user_id to the public scope", () => {
    expect(
      createUploadTaskSchema.parse({
        user_id: "",
        items: [{ filename: "demo.png", size_bytes: 3 }],
      }),
    ).toEqual({
      user_id: null,
      callback_url: null,
      items: [
        {
          filename: "demo.png",
          size_bytes: 3,
          content_type: null,
        },
      ],
    });
  });

  it("rejects the removed auto_publish upload field", () => {
    expect(() =>
      createUploadTaskSchema.parse({
        auto_publish: false,
        items: [{ filename: "demo.png", size_bytes: 3 }],
      }),
    ).toThrow();
  });

  it("enforces the per-task item and byte limits", () => {
    expect(() =>
      createUploadTaskSchema.parse({
        items: Array.from({ length: MAX_UPLOAD_TASK_ITEMS + 1 }, (_, index) => ({
          filename: `${index}.png`,
          size_bytes: 1,
        })),
      }),
    ).toThrow();
    expect(() =>
      createUploadTaskSchema.parse({
        items: [
          { filename: "first.mp4", size_bytes: MAX_UPLOAD_TASK_BYTES },
          { filename: "second.png", size_bytes: 1 },
        ],
      }),
    ).toThrow(/2 GiB/);
  });

  it("enforces stricter deployment upload limits before touching storage", async () => {
    const previousItems = process.env.UPLOAD_MAX_ITEMS;
    const previousBytes = process.env.UPLOAD_MAX_TOTAL_BYTES;
    const service = new DefaultApiV1Service();
    try {
      process.env.UPLOAD_MAX_ITEMS = "1";
      process.env.UPLOAD_MAX_TOTAL_BYTES = "100";
      await expect(
        service.createUploadTask({
          user_id: null,
          callback_url: null,
          items: [
            { filename: "first.png", size_bytes: 1, content_type: null },
            { filename: "second.png", size_bytes: 1, content_type: null },
          ],
        }),
      ).rejects.toMatchObject({
        code: "file_too_large",
        status: 413,
        message: "每个上传任务最多包含 1 个文件。",
      });

      process.env.UPLOAD_MAX_ITEMS = "100";
      process.env.UPLOAD_MAX_TOTAL_BYTES = "2";
      await expect(
        service.createUploadTask({
          user_id: null,
          callback_url: null,
          items: [
            { filename: "three.png", size_bytes: 3, content_type: null },
          ],
        }),
      ).rejects.toMatchObject({
        code: "file_too_large",
        status: 413,
        details: [{ size_bytes: 3, limit_bytes: 2 }],
      });
    } finally {
      if (previousItems === undefined) delete process.env.UPLOAD_MAX_ITEMS;
      else process.env.UPLOAD_MAX_ITEMS = previousItems;
      if (previousBytes === undefined) delete process.env.UPLOAD_MAX_TOTAL_BYTES;
      else process.env.UPLOAD_MAX_TOTAL_BYTES = previousBytes;
    }
  });

  it("creates one manifest task and returns its canonical task URL", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await createUpload(
      jsonRequest("http://localhost/api/v1/uploads", {
        user_id: "user-7",
        callback_url: "https://callback.example.test/assets",
        items: [{ filename: "demo.png", size_bytes: 3 }],
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = await response.json();
    expect(body).toMatchObject({
      task_id: taskId,
      task_type: "upload",
      received_bytes: 0,
      total_items: 1,
    });
    expect(body).not.toHaveProperty("taskId");
    expect(body).not.toHaveProperty("receivedBytes");
    expect(service.createUploadTask).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-7" }),
    );
  });

  it("accepts the legacy ASR/LLM match body and keeps its camelCase contract", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const input = {
      asr: {
        transcripts: [
          {
            sentences: [
              {
                text: "如果能回到二十岁。",
                words: [
                  {
                    text: "如果能回到二十岁",
                    begin_time: 320,
                    end_time: 1_600,
                    punctuation: "。",
                  },
                ],
              },
            ],
          },
        ],
      },
      llm: JSON.stringify({
        segments: [
          {
            segment_id: 1,
            text: "如果能回到二十岁",
            high_light_word: "二十岁",
            level: 2,
          },
        ],
      }),
      text: "如果能回到二十岁。",
      asset_url_list: [],
      callback_url: "https://callback.example.test/legacy",
      business_id: "biz-7",
    };
    const response = await createCompatibilityMatch(
      new Request("http://internal.invalid/api/v1/compat/segment-match", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "focus.example.com",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify(input),
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(await response.json()).toEqual({ taskId, status: "processing" });
    expect(service.createCompatibilityMatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-7",
        llm: expect.objectContaining({ segments: expect.any(Array) }),
      }),
      "https://focus.example.com",
    );
  });

  it("accepts the legacy pre-aligned compatibility request shape", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await createCompatibilityMatch(
      new Request("http://internal.invalid/api/v1/compat/segment-match", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "focus.example.com",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({
          callback_url: "https://callback.example.test/legacy",
          asr: {},
          text: "做过生意的人都明白",
          llm: {
            segments: [
              {
                segment_id: 1,
                text: "做过生意的人都明白",
                keyword: "",
                level: 1,
                group_id: [1, 4],
                start_time: 0.28,
                end_time: 1.56,
              },
            ],
          },
          asset_url_list: [
            {
              file_url: "https://media.example.test/source.mp4",
              type: "video",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ taskId, status: "processing" });
    expect(service.createCompatibilityMatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        asr: {},
        asset_url_list: [
          expect.objectContaining({ type: "video" }),
        ],
      }),
      "https://focus.example.com",
    );
  });

  it("passes the upload stream to the service without buffering it in the route", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await receiveUploadItem(
      new Request(
        `http://localhost/api/v1/uploads/${taskId}/items/${itemId}`,
        {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
      { params: Promise.resolve({ taskId, itemId }) },
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(await response.json()).toMatchObject({
      task_id: taskId,
      received_bytes: 3,
      progress_percent: 100,
    });
    expect(service.receiveUploadItem).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        itemId,
        contentLength: 3,
        contentType: "image/png",
        body: expect.any(ReadableStream),
      }),
    );
  });

  it("seals an upload asynchronously and points clients at the unified task endpoint", async () => {
    const service = fakeService();
    service.sealUploadTask.mockResolvedValue(
      task({ status: "running", phase: "validating" }),
    );
    installApiV1Service(service);
    const response = await sealUploadTask(
      new Request(`http://localhost/api/v1/uploads/${taskId}`, {
        method: "POST",
      }),
      { params: Promise.resolve({ taskId }) },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      task_id: taskId,
      status: "running",
      phase: "validating",
    });
    expect(service.sealUploadTask).toHaveBeenCalledWith(taskId);
  });

  it("returns a canonical snake_case task representation", async () => {
    const service = fakeService();
    service.getTask.mockResolvedValue(
      task({
        status: "running",
        phase: "analyzing",
        progress_percent: 72.5,
      }),
    );
    installApiV1Service(service);
    const response = await getTask(
      new Request(`http://localhost/api/v1/tasks/${taskId}`),
      { params: Promise.resolve({ taskId }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      task_id: taskId,
      task_type: "upload",
      progress_percent: 72.5,
      total_items: 1,
    });
    expect(body).not.toHaveProperty("taskId");
    expect(body).not.toHaveProperty("progressPercent");
    expect(service.getTask).toHaveBeenCalledWith(taskId);
  });

  it("validates path IDs before querying a task", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await getTask(
      new Request("http://localhost/api/v1/tasks/not-a-uuid"),
      { params: Promise.resolve({ taskId: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(service.getTask).not.toHaveBeenCalled();
  });

  it("defaults asset queries to public assets", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await queryAssets(
      jsonRequest("http://localhost/api/v1/assets/query", {}),
    );
    expect(response.status).toBe(200);
    expect(service.queryAssets).toHaveBeenCalledWith({
      cursor: null,
      filter: { user_scope: { mode: "public" } },
      include_tag_statistics: true,
      limit: 20,
    });
  });

  it("gets an asset in the requested user scope using snake_case fields", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await getAsset(
      new Request(
        `http://localhost/api/v1/assets/${assetId}?user_id=user-7`,
      ),
      { params: Promise.resolve({ assetId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      asset_id: assetId,
      user_id: "user-7",
      parent_video_id: null,
      original_filename: "demo.png",
      size_bytes: 3,
    });
    expect(body).not.toHaveProperty("assetId");
    expect(body).not.toHaveProperty("originalFilename");
    expect(service.getAsset).toHaveBeenCalledWith(assetId, {
      mode: "user",
      user_id: "user-7",
    });
  });

  it("returns SQL-backed storage usage and a paged direct-link media list", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const context = { params: Promise.resolve({ userId: "user%2D7" }) };
    const usageResponse = await getUserStorageUsage(
      new Request("http://localhost/api/v1/users/user%2D7/storage-usage"),
      context,
    );
    expect(usageResponse.status).toBe(200);
    expect(await usageResponse.json()).toMatchObject({
      user_id: "user-7",
      total_files: 2,
      total_bytes: 18,
      image_bytes: 3,
      video_bytes: 15,
    });
    expect(service.getUserStorageUsage).toHaveBeenCalledWith("user-7");

    const mediaResponse = await getUserMedia(
      new Request("http://localhost/api/v1/users/user%2D7/media?limit=25"),
      context,
    );
    expect(mediaResponse.status).toBe(200);
    const mediaBody = await mediaResponse.json();
    expect(mediaBody).toMatchObject({
      user_id: "user-7",
      has_more: false,
      items: [{ media_type: "image", size_bytes: 3 }],
    });
    expect(mediaBody.items[0].media_url).toMatch(/^http:\/\/localhost\//);
    expect(mediaBody.items[0].media_url).not.toContain("test-api-key");
    expect(service.listUserMedia).toHaveBeenCalledWith("user-7", {
      cursor: null,
      limit: 25,
    }, "http://localhost");
  });

  it("keeps the WebUI user directory behind the page lock", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const key = "u".repeat(64);
    vi.stubEnv("APP_MODE", "prd");
    vi.stubEnv("WEBUI_LOCK_KEY", key);

    const unauthorized = await getWebUiUsers(
      new Request("http://localhost/api/webui/users"),
    );
    expect(unauthorized.status).toBe(401);
    expect(service.listUsers).not.toHaveBeenCalled();

    const response = await getWebUiUsers(
      new Request("http://localhost/api/webui/users", {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      items: [
        { user_id: "user-7", asset_count: 1 },
        { user_id: "user-8", display_name: "用户 8", asset_count: 3 },
      ],
    });
    expect(service.listUsers).toHaveBeenCalledOnce();
  });

  it("rejects empty, overlong, or malformed encoded user IDs", async () => {
    const service = fakeService();
    installApiV1Service(service);
    for (const userId of ["%20", "%E0%A4%A", "x".repeat(192)]) {
      const response = await getUserStorageUsage(
        new Request(`http://localhost/api/v1/users/${userId}/storage-usage`),
        { params: Promise.resolve({ userId }) },
      );
      expect(response.status).toBe(400);
    }
    expect(service.getUserStorageUsage).not.toHaveBeenCalled();
  });

  it("submits an asset update as an asynchronous task", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await updateAsset(
      jsonRequest(
        `http://localhost/api/v1/assets/${assetId}`,
        {
          user_id: "user-7",
          callback_url: "https://callback.example.test/update",
          name: "renamed",
          description: "updated description",
          tags: [{ category: "scene", value: "studio" }],
        },
        "PATCH",
      ),
      { params: Promise.resolve({ assetId }) },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(await response.json()).toMatchObject({
      task_id: taskId,
      task_type: "update",
      phase: "updating",
    });
    expect(service.updateAsset).toHaveBeenCalledWith(assetId, {
      user_id: "user-7",
      callback_url: "https://callback.example.test/update",
      name: "renamed",
      description: "updated description",
      tags: [{ category: "scene", value: "studio" }],
    });
  });

  it("submits publish and retry operations with default public context", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const cases = [
      {
        name: "publish",
        route: publishAsset,
        spy: service.publishAsset,
        taskType: "publish",
        phase: "publishing",
      },
      {
        name: "retry",
        route: retryAsset,
        spy: service.retryAsset,
        taskType: "retry",
        phase: "retrying",
      },
    ] as const;

    for (const operation of cases) {
      const response = await operation.route(
        new Request(
          `http://localhost/api/v1/assets/${assetId}/${operation.name}`,
          {
            method: "POST",
          },
        ),
        { params: Promise.resolve({ assetId }) },
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
      expect(await response.json()).toMatchObject({
        task_id: taskId,
        task_type: operation.taskType,
        phase: operation.phase,
      });
      expect(operation.spy).toHaveBeenCalledWith(assetId, {
        user_id: null,
        callback_url: null,
      });
    }
  });

  it("passes Range and user scope through the media endpoint unchanged", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const request = new Request(
      `http://localhost/api/v1/media/${assetId}?user_id=user-7`,
      {
        headers: { range: "bytes=2-4" },
      },
    );
    const response = await getMedia(request, {
      params: Promise.resolve({ assetId }),
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([2, 3, 4]),
    );
    expect(service.getMedia).toHaveBeenCalledWith(
      assetId,
      { mode: "user", user_id: "user-7" },
      request,
    );
    expect(request.headers.get("range")).toBe("bytes=2-4");
  });

  it("allows direct media and thumbnail links without authentication", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const mediaRequest = new Request(
      `http://localhost/api/v1/media/${assetId}?user_id=user-7`,
    );
    expect(
      (await getMedia(mediaRequest, { params: Promise.resolve({ assetId }) }))
        .status,
    ).toBe(206);

    const thumbnailRequest = new Request(
      `http://localhost/api/v1/media/${assetId}/thumbnail?user_id=user-7`,
    );
    const thumbnail = await getThumbnail(thumbnailRequest, {
      params: Promise.resolve({ assetId }),
    });
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    expect(service.getThumbnail).toHaveBeenCalledWith(
      assetId,
      { mode: "user", user_id: "user-7" },
      thumbnailRequest,
    );
  });

  it("uses an absent user_id for the asynchronous public hard-delete branch", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await deleteAsset(
      new Request(`http://localhost/api/v1/assets/${assetId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ assetId }) },
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${taskId}`);
    expect(service.deleteAsset).toHaveBeenCalledWith(assetId, {
      user_id: null,
      callback_url: null,
    });
  });

  it("keeps OpenAPI public when the dev WebUI lock is disabled", async () => {
    vi.stubEnv("APP_MODE", "dev");
    vi.stubEnv("WEBUI_LOCK_KEY", "");
    const response = await getOpenApi(
      new Request("http://localhost/api/v1/openapi"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/yaml; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const specification = await response.text();
    expect(specification).toContain("openapi: 3.1.0");
    for (const path of [
      "/api/v1/uploads:",
      "/api/v1/uploads/{task_id}/items/{item_id}:",
      "/api/v1/uploads/{task_id}:",
      "/api/v1/tasks/{task_id}:",
      "/api/v1/assets/query:",
      "/api/v1/assets/{asset_id}:",
      "/api/v1/assets/{asset_id}/publish:",
      "/api/v1/assets/{asset_id}/retry:",
      "/api/v1/media/{asset_id}:",
      "/api/v1/media/{asset_id}/thumbnail:",
      "/api/v1/users/{user_id}/media:",
      "/api/v1/users/{user_id}/storage-usage:",
      "/api/v1/openapi:",
    ]) {
      expect(specification).toContain(path);
    }
    expect(specification).not.toContain("/api/ui/v1/");
  });
});
