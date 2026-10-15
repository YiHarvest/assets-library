import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock("@/server/services/call-monitor", () => ({ listCalls: mocks.list, callDetail: mocks.detail }));
import { GET as list } from "@/app/api/v1/monitor/calls/route";
import { GET as detail } from "@/app/api/v1/monitor/calls/[spanId]/route";
beforeEach(() => vi.clearAllMocks());

it("统一调用列表接受类型、状态、Trace/Task 和名称筛选", async () => {
  mocks.list.mockResolvedValue({ items: [], total: 0 });
  const id = crypto.randomUUID();
  expect((await list(new Request(`http://localhost/api/v1/monitor/calls?kind=function&task_id=${id}&q=getAsset`))).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({ kind: "function", task_id: id, q: "getAsset", page: 1, limit: 30 });
  for (const query of ["kind=bad", "status=queued", "trace_id=bad", "limit=101"]) {
    expect((await list(new Request(`http://localhost/api/v1/monitor/calls?${query}`))).status).toBe(400);
  }
});

it("调用详情校验 ID 和增量日志游标", async () => {
  const id = crypto.randomUUID();
  mocks.detail.mockResolvedValue({ call: {}, logs: [], next_after: 4, has_more: false });
  expect((await detail(new Request(`http://localhost/api/v1/monitor/calls/${id}?after=4`), { params: Promise.resolve({ spanId: id }) })).status).toBe(200);
  expect(mocks.detail).toHaveBeenCalledWith(id, 4, 100);
  expect((await detail(new Request("http://localhost/api/v1/monitor/calls/bad"), { params: Promise.resolve({ spanId: "bad" }) })).status).toBe(400);
});
