import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as store from "@/server/observability/store";
import { observe, logCall, observeJob } from "@/server/observability/trace";
import { taskTraceFields } from "@/server/observability/context";
import { snapshot } from "@/server/observability/payload";
import { parseJson, withApiV1 } from "@/server/api/handler";
import { auditLog } from "@/server/observability/audit-log";

beforeEach(() => vi.clearAllMocks());

describe("统一调用观测", () => {
  it("并发请求的上下文隔离，嵌套函数关联父调用", async () => {
    await Promise.all(["first", "second"].map((name) => observe(name, { name }, async () => {
      await new Promise((resolve) => setTimeout(resolve, name === "first" ? 5 : 1));
      return observe(`${name}.child`, null, async () => taskTraceFields());
    }, { kind: "api" })));
    const starts = vi.mocked(store.startCall).mock.calls.map(([row]) => row);
    for (const name of ["first", "second"]) {
      const parent = starts.find((row) => row.name === name)!;
      const child = starts.find((row) => row.name === `${name}.child`)!;
      expect(child.parentSpanId).toBe(parent.id); expect(child.traceId).toBe(parent.traceId);
    }
    expect(starts.find((row) => row.name === "first")!.traceId).not.toBe(starts.find((row) => row.name === "second")!.traceId);
  });

  it("API、函数的输出和 task_id 能关联，并保留原返回值", async () => {
    const taskId = crypto.randomUUID();
    const response = await withApiV1(new Request("http://localhost/api/v1/uploads", { method: "POST", body: JSON.stringify({ name: "demo", password: "hidden" }) }), async () => {
      const input = await parseJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ name: "demo", password: "hidden" }) }), z.object({ name: z.string(), password: z.string() }));
      return Response.json(await observe("createTask", input, async () => ({ task_id: taskId })), { status: 202 });
    });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ task_id: taskId });
    const finishes = vi.mocked(store.finishCall).mock.calls.map(([, row]) => row);
    expect(finishes).toHaveLength(2);
    expect(finishes.every((row) => row.taskId === taskId && row.status === "done")).toBe(true);
    expect(JSON.stringify(finishes)).not.toContain("hidden");
    expect(response.headers.get("x-trace-id")).toBe(finishes[0].traceId);
  });

  it("函数错误保持原异常，API 校验错误记录为失败", async () => {
    const failure = new Error("upstream unavailable");
    await expect(observe("failedFunction", {}, async () => { throw failure; })).rejects.toBe(failure);
    expect(vi.mocked(store.finishCall).mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed", error: { message: "upstream unavailable" } });
    const request = new Request("http://localhost/api/v1/match", { method: "POST", body: '{"query":3}' });
    const response = await withApiV1(request, async () => Response.json(await parseJson(request, z.object({ query: z.string() }))));
    expect(response.status).toBe(400);
    expect(vi.mocked(store.finishCall).mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed", statusCode: 400, input: { body: { query: 3 } } });
  });

  it("监控查询及内部函数都不生成新的观测记录", async () => {
    for (const path of ["/api/v1/monitor/calls", "/api/v1/tasks", `/api/v1/tasks/${crypto.randomUUID()}/monitor`]) {
      await withApiV1(new Request(`http://localhost${path}`), () => observe("monitorInternal", {}, async () => Response.json({ items: [] })));
    }
    expect(store.startCall).not.toHaveBeenCalled();
  });

  it("记录媒体响应元数据，不读取或消耗字节流", async () => {
    const response = await withApiV1(new Request("http://localhost/api/v1/media/asset"), async () => new Response("video-bytes", { headers: { "content-type": "video/mp4" } }));
    expect(await response.text()).toBe("video-bytes");
    expect(vi.mocked(store.finishCall).mock.calls.at(-1)?.[1].output).toMatchObject({ content_type: "video/mp4", streamed: true });
  });

  it("观测存储故障不改变业务结果", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(store.startCall).mockRejectedValueOnce(new Error("DB offline"));
    await expect(observe("business", {}, async () => 42)).resolves.toBe(42);
    expect(store.finishCall).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("已有审计事件按顺序写入调用和任务，脱敏后在调用结束前保存", async () => {
    const consoleLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const taskId = crypto.randomUUID();
    try {
      await observe("upload", {}, async () => {
        taskTraceFields(taskId);
        auditLog("upload_stream_started", { task_id: taskId, password: "hidden-value" });
        auditLog("upload_stream_completed", { task_id: taskId, bytes: 42 });
        await logCall("下一步");
        return { taskId };
      });
      const calls = vi.mocked(store.insertCallLog).mock.calls;
      expect(calls.map(([row]) => row.message)).toEqual(["开始接收上传文件。", "文件接收完成。", "下一步"]);
      expect(store.insertTaskLog).toHaveBeenCalledTimes(2);
      expect(store.insertTaskLog).toHaveBeenLastCalledWith(expect.objectContaining({ taskId, phase: "upload_stream_completed", data: expect.objectContaining({ bytes: 42 }) }));
      expect(JSON.stringify(calls)).not.toContain("hidden-value");
      expect(vi.mocked(store.insertCallLog).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(store.finishCall).mock.invocationCallOrder[0]);
    } finally { consoleLog.mockRestore(); }
  });

  it("worker 恢复任务的 Trace、父调用及真实失败状态", async () => {
    const traceId = crypto.randomUUID(), parentSpanId = crypto.randomUUID(), taskId = crypto.randomUUID();
    vi.mocked(store.taskCallContext).mockResolvedValueOnce({ traceId, parentSpanId });
    vi.mocked(store.jobCallOutcome).mockResolvedValueOnce({ failed: true, output: { job_id: "job", status: "failed", attempt: 1, phase: "finished" }, error: { code: "failure", message: "error" } });
    await observeJob("processJob(match)", { id: "job", taskId, attempt: 1 }, {}, async () => { await logCall("开始匹配"); });
    expect(store.startCall).toHaveBeenCalledWith(expect.objectContaining({ traceId, parentSpanId, taskId }));
    expect(store.insertCallLog).toHaveBeenCalledWith(expect.objectContaining({ message: "开始匹配" }));
    expect(store.finishCall).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "failed", taskId }));
  });

  it("敏感信息脱敏、循环对象和大参数不会破坏记录", () => {
    const value: Record<string, unknown> = { password: "private", uri: "mysql://root:private@localhost/db", nested: '{"token":"private"}', bytes: new Uint8Array(10), large: "x".repeat(20000) };
    value.self = value;
    const result = snapshot(value);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).toMatchObject({ password: "[REDACTED]", bytes: { binary: true, byte_length: 10 }, self: "[circular]" });
    expect(JSON.stringify(result).length).toBeLessThan(10000);
  });
});
