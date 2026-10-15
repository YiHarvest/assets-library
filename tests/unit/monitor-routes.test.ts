import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), detail: vi.fn(), logs: vi.fn() }));
vi.mock("@/server/services/match", () => ({ createMatchTask: mocks.create }));
vi.mock("@/server/services/task-monitor", () => ({ listMonitorTasks: mocks.list, getMonitorDetail: mocks.detail, getTaskLogs: mocks.logs }));
import { POST } from "@/app/api/v1/match/route";
import { GET as list } from "@/app/api/v1/tasks/route";
import { GET as detail } from "@/app/api/v1/tasks/[taskId]/monitor/route";
import { GET as logs } from "@/app/api/v1/tasks/[taskId]/logs/route";
import { ApiV1Error } from "@/server/api/errors";

const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ taskId: id }) };
beforeEach(() => vi.clearAllMocks());

describe("match 与 monitor API", () => {
  it("匹配返回 202 和统一 task Location，默认公共范围", async () => {
    mocks.create.mockResolvedValue({ task_id: id, task_type: "match", status: "queued" });
    const response = await POST(new Request("http://localhost/api/v1/match", { method: "POST", body: JSON.stringify({ query: "海边汽车" }) }));
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/tasks/${id}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.create).toHaveBeenCalledWith({ query: "海边汽车", filter: { user_scope: { mode: "public" } }, limit: 10, min_score: 0, callback_url: null });
  });
  it.each([{ query: " " }, { query: "x", limit: 101 }, { query: "x", min_score: -1 }, { query: "x", filter: { user_scope: { mode: "user" } } }, { query: "x", unknown: true }])("无效匹配入参不创建任务：%j", async (body) => {
    const response = await POST(new Request("http://localhost/api/v1/match", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("列表解析筛选条件和分页，拒绝无效状态与过大页大小", async () => {
    mocks.list.mockResolvedValue({ items: [] });
    expect((await list(new Request("http://localhost/api/v1/tasks?type=match&status=failed&page=2&limit=10"))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ type: "match", status: "failed", page: 2, limit: 10 });
    for (const query of ["status=bad", "limit=1000", "page=0", "task_id=x"]) {
      expect((await list(new Request(`http://localhost/api/v1/tasks?${query}`))).status).toBe(400);
    }
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
  it("日志使用递增游标，不接受负数或非法 UUID", async () => {
    mocks.logs.mockResolvedValue({ items: [], next_after: 12, has_more: false });
    const response = await logs(new Request(`http://localhost/api/v1/tasks/${id}/logs?after=12&limit=20`), context);
    expect(response.status).toBe(200); expect(mocks.logs).toHaveBeenCalledWith(id, { after: 12, limit: 20 });
    expect((await logs(new Request(`http://localhost/logs?after=-1`), context)).status).toBe(400);
    expect((await detail(new Request("http://localhost/monitor"), { params: Promise.resolve({ taskId: "invalid" }) })).status).toBe(400);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("已过期或不存在的任务返回 404 结构化错误", async () => {
    mocks.detail.mockRejectedValue(new ApiV1Error("not_found", "任务不存在。", 404));
    const response = await detail(new Request("http://localhost/monitor"), context);
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
