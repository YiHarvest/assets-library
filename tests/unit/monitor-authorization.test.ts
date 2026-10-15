import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWebUiSession, WEBUI_LOCK_COOKIE_NAME } from "@/server/auth/webui-lock";

const mocks = vi.hoisted(() => ({ list: vi.fn().mockResolvedValue({ items: [] }) }));
vi.mock("@/server/services/call-monitor", () => ({ listCalls: mocks.list, callDetail: vi.fn() }));
vi.mock("@/server/services/task-monitor", () => ({ listMonitorTasks: vi.fn(), getMonitorDetail: vi.fn(), getTaskLogs: vi.fn() }));
import { GET as calls } from "@/app/api/v1/monitor/calls/route";
import { GET as call } from "@/app/api/v1/monitor/calls/[spanId]/route";
import { GET as tasks } from "@/app/api/v1/tasks/route";
import { GET as task } from "@/app/api/v1/tasks/[taskId]/monitor/route";
import { GET as logs } from "@/app/api/v1/tasks/[taskId]/logs/route";

const key = "monitor-test-session-key-32-characters";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_MODE", "dev");
  vi.stubEnv("WEBUI_LOCK_KEY", key);
});
afterEach(() => vi.unstubAllEnvs());

it("页面锁启用时所有监控查询拒绝未授权请求", async () => {
  const request = new Request("http://localhost/feisu/assets-library/api/v1/monitor/calls");
  const responses = await Promise.all([
    calls(request), call(request, { params: Promise.resolve({ spanId: id }) }),
    tasks(request), task(request, { params: Promise.resolve({ taskId: id }) }),
    logs(request, { params: Promise.resolve({ taskId: id }) }),
  ]);
  expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401, 401]);
  expect(mocks.list).not.toHaveBeenCalled();
});

it("监控复用 WebUI 签名会话并支持部署前缀", async () => {
  const session = await createWebUiSession(key);
  const response = await calls(new Request("http://localhost/feisu/assets-library/api/v1/monitor/calls", {
    headers: { cookie: `${WEBUI_LOCK_COOKIE_NAME}=${session}` },
  }));
  expect(response.status).toBe(200);
  expect(mocks.list).toHaveBeenCalledOnce();
});
