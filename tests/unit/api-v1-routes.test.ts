import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiV1Service, StagedUpload } from "@/server/api/v1/service";
import { installApiV1Service } from "@/server/api/v1/service";
import type { ApiV1AssetDetail, TaskStatusResponse } from "@/shared/contracts";
import { POST as upload } from "@/app/api/v1/uploads/route";
import { GET as getTask } from "@/app/api/v1/tasks/route";
import { POST as listAssets } from "@/app/api/v1/assets/list/route";
import { POST as searchAssets } from "@/app/api/v1/assets/search/route";
import { GET as getAsset } from "@/app/api/v1/assets/detail/route";
import { PATCH as updateAsset } from "@/app/api/v1/assets/route";
import { POST as actOnAsset } from "@/app/api/v1/assets/actions/route";
import { POST as storageUsage } from "@/app/api/v1/storage/usage/route";
import { GET as getMedia } from "@/app/api/v1/media/route";
import { GET as getThumbnail } from "@/app/api/v1/thumbnail/route";
import { GET as getOpenApi } from "@/app/api/v1/openapi/route";

const taskId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const now = "2026-08-13T10:00:00+08:00";

function task(overrides: Partial<TaskStatusResponse> = {}): TaskStatusResponse {
  return {
    task_id: taskId,
    task_type: "upload",
    status: "running",
    phase: "validating",
    progress_percent: 0,
    total_files: 1,
    done_files: 0,
    failed_files: 0,
    callback_url: null,
    result: { auto_publish: false },
    files: [
      {
        item_id: itemId,
        filename: "demo.png",
        media_type: "image",
        status: "queued",
        phase: "validating",
        received_bytes: 3,
        total_bytes: 3,
        progress_percent: 100,
        asset_ids: [],
        error: null,
      },
    ],
    error: null,
    created_at: now,
    started_at: now,
    finished_at: null,
    expires_at: null,
    ...overrides,
  };
}

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
  tags: [],
  media_url: `/api/v1/media?asset_id=${assetId}`,
  thumbnail_url: null,
  created_at: now,
  updated_at: now,
  original_filename: "demo.png",
  mime_type: "image/png",
  size_bytes: 3,
  auto_publish: true,
  failure: null,
  analysis: null,
};

function fakeService() {
  return {
    submitUpload: vi.fn(async () => task()),
    getTask: vi.fn(async () => task()),
    listAssets: vi.fn(async (input) => ({
      user_id: input.user_id,
      items: [],
      next_cursor: null,
      has_more: false,
    })),
    searchAssets: vi.fn(async () => ({
      items: [],
      next_cursor: null,
      has_more: false,
      tag_statistics: null,
    })),
    getAsset: vi.fn(async () => asset),
    updateAsset: vi.fn(async () => task({ task_type: "update", phase: "updating" })),
    actOnAsset: vi.fn(async (input) =>
      task({ task_type: input.action, phase: input.action === "delete" ? "deleting" : "publishing" }),
    ),
    getStorageUsage: vi.fn(async (userId) => ({
      user_id: userId,
      total_files: 0,
      image_files: 0,
      video_files: 0,
      total_bytes: 0,
      image_bytes: 0,
      video_bytes: 0,
      items: [],
    })),
    getMedia: vi.fn(async () =>
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { "content-type": "video/mp4" },
      }),
    ),
    getThumbnail: vi.fn(async () =>
      new Response(new Uint8Array([3]), {
        headers: { "content-type": "image/jpeg" },
      }),
    ),
  } satisfies ApiV1Service;
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("静态 API v1 路由", () => {
  let mediaRoot: string;

  beforeEach(async () => {
    mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assets-api-v1-"));
    process.env.MEDIA_ROOT = mediaRoot;
  });

  afterEach(async () => {
    installApiV1Service(undefined);
    delete process.env.MEDIA_ROOT;
    await fs.rm(mediaRoot, { recursive: true, force: true });
  });

  it("用重复 files 字段流式接收图片并提交已经落盘的任务", async () => {
    const service = fakeService();
    let staged: StagedUpload | undefined;
    service.submitUpload.mockImplementation(async (...arguments_: StagedUpload[]) => {
      const [input] = arguments_;
      if (!input) throw new Error("missing staged upload");
      staged = input;
      await expect(
        fs.readFile(path.join(mediaRoot, input.files[0]!.stagingPath)),
      ).resolves.toEqual(Buffer.from([1, 2, 3]));
      return task();
    });
    installApiV1Service(service);
    const body = new FormData();
    body.set("user_id", "user-7");
    body.set("auto_publish", "true");
    body.append("files", new File([new Uint8Array([1, 2, 3])], "one.png"));
    body.append("files", new File([new Uint8Array([4, 5])], "two.jpg"));

    const response = await upload(
      new Request("http://localhost/api/v1/uploads", { method: "POST", body }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks?task_id=${taskId}`);
    expect(staged).toMatchObject({
      user_id: "user-7",
      auto_publish: true,
      files: [
        { ordinal: 0, filename: "one.png", mediaType: "image", sizeBytes: 3 },
        { ordinal: 1, filename: "two.jpg", mediaType: "image", sizeBytes: 2 },
      ],
    });
  });

  it("拒绝图片视频混合、未知字段和非 multipart 请求", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const mixed = new FormData();
    mixed.append("files", new File(["image"], "one.png"));
    mixed.append("files", new File(["video"], "one.mp4"));
    expect(
      await upload(
        new Request("http://localhost/api/v1/uploads", {
          method: "POST",
          body: mixed,
        }),
      ),
    ).toMatchObject({ status: 400 });

    const unknown = new FormData();
    unknown.set("content_type", "image/png");
    unknown.append("files", new File(["image"], "one.png"));
    expect(
      await upload(
        new Request("http://localhost/api/v1/uploads", {
          method: "POST",
          body: unknown,
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await upload(jsonRequest("http://localhost/api/v1/uploads", {})),
    ).toMatchObject({ status: 415 });
    expect(service.submitUpload).not.toHaveBeenCalled();
  });

  it("通过 task_id 查询统一任务状态", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await getTask(
      new Request(`http://localhost/api/v1/tasks?task_id=${taskId}`),
    );
    expect(response.status).toBe(200);
    expect(service.getTask).toHaveBeenCalledWith(taskId);
    expect(await response.json()).toMatchObject({ total_files: 1, files: [{ item_id: itemId }] });
  });

  it("列表把空 user_id 规范成公共库并传递静态源站", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await listAssets(
      new Request("http://localhost/api/v1/assets/list", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "assets.internal:23015",
          "x-forwarded-host": "media.example.test",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ user_id: "", limit: 25 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(service.listAssets).toHaveBeenCalledWith(
      { user_id: null, cursor: null, limit: 25 },
      "https://media.example.test",
    );
  });

  it("搜索保留 scope、媒体、状态、发布状态、标签和语义字段", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const payload = {
      query: "日落",
      keywords: ["海边"],
      filter: {
        user_scope: { mode: "user", user_id: "user-7" },
        media_types: ["video"],
        statuses: ["done"],
        review_statuses: ["published"],
        tags: [{ category: "scene", value: "beach" }],
      },
      limit: 10,
    };
    const response = await searchAssets(
      jsonRequest("http://localhost/api/v1/assets/search", payload),
    );
    expect(response.status).toBe(200);
    expect(service.searchAssets).toHaveBeenCalledWith({
      ...payload,
      cursor: null,
      include_tag_statistics: true,
    });
  });

  it("详情只使用 asset_id，不再要求 user_id", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await getAsset(
      new Request(`http://localhost/api/v1/assets/detail?asset_id=${assetId}`),
    );
    expect(response.status).toBe(200);
    expect(service.getAsset).toHaveBeenCalledWith(assetId);
  });

  it("PATCH 和统一 actions 从 JSON 中读取 asset_id", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const update = {
      asset_id: assetId,
      user_id: "user-7",
      callback_url: null,
      name: "新名称",
      description: "新描述",
      tags: [],
    };
    const updateResponse = await updateAsset(
      jsonRequest("http://localhost/api/v1/assets", update, "PATCH"),
    );
    expect(updateResponse.status).toBe(202);
    expect(service.updateAsset).toHaveBeenCalledWith(update);

    const action = {
      asset_id: assetId,
      action: "delete" as const,
      user_id: null,
      callback_url: null,
    };
    const actionResponse = await actOnAsset(
      jsonRequest("http://localhost/api/v1/assets/actions", action),
    );
    expect(actionResponse.status).toBe(202);
    expect(service.actOnAsset).toHaveBeenCalledWith(action);
  });

  it("公共库空间统计使用 nullable user_id", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const response = await storageUsage(
      jsonRequest("http://localhost/api/v1/storage/usage", { user_id: null }),
    );
    expect(response.status).toBe(200);
    expect(service.getStorageUsage).toHaveBeenCalledWith(null);
  });

  it("媒体和首帧通过静态 query asset_id 读取并透传 Range", async () => {
    const service = fakeService();
    installApiV1Service(service);
    const mediaRequest = new Request(
      `http://localhost/api/v1/media?asset_id=${assetId}`,
      { headers: { range: "bytes=0-1" } },
    );
    expect((await getMedia(mediaRequest)).status).toBe(206);
    expect(service.getMedia).toHaveBeenCalledWith(assetId, mediaRequest);

    const thumbnailRequest = new Request(
      `http://localhost/api/v1/thumbnail?asset_id=${assetId}`,
    );
    expect((await getThumbnail(thumbnailRequest)).status).toBe(200);
    expect(service.getThumbnail).toHaveBeenCalledWith(assetId, thumbnailRequest);
  });

  it("OpenAPI 仍可从静态端点读取", async () => {
    const response = await getOpenApi();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/yaml");
  });
});
