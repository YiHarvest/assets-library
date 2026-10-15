import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { initializeDatabase } from "@/server/db/migrations";
import { bindIntegrationDatabaseEnvironment } from "../helpers/integration-database";

vi.unmock("@/server/observability/store");
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("统一观测 MySQL 链路", () => {
  let database: typeof import("@/server/db");
  let schema: typeof import("@/server/db/schema");
  const taskIds: string[] = [];
  const traceIds: string[] = [];

  beforeAll(async () => {
    bindIntegrationDatabaseEnvironment(url!);
    process.env.DATABASE_SSL_CA_PATH = "";
    process.env.EMBEDDING_MODEL = "";
    const connection = await initializeDatabase({ url: url! });
    await connection.pool.end();
    database = await import("@/server/db"); schema = await import("@/server/db/schema");
  });

  afterAll(async () => {
    if (!database) return;
    for (const id of taskIds) await database.db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    for (const id of traceIds) await database.db.delete(schema.callSpans).where(eq(schema.callSpans.traceId, id));
    await database.pool.end();
  });

  test("API → 函数 → durable task → worker → Match 使用同一个 Trace，错误可查询", async () => {
    const { POST } = await import("@/app/api/v1/match/route");
    const response = await POST(new Request("http://localhost/api/v1/match", { method: "POST", body: JSON.stringify({ query: "integration-check" }) }));
    expect(response.status).toBe(202);
    const task = await response.json(); taskIds.push(task.task_id);
    const trace = response.headers.get("x-trace-id")!; traceIds.push(trace);
    const { claimNextJob } = await import("@/server/repositories/assets");
    const job = await claimNextJob();
    expect(job?.taskId).toBe(task.task_id);
    const { processJob } = await import("@/server/services/processing");
    await processJob(job!);
    const { listCalls, callDetail } = await import("@/server/services/call-monitor");
    const list = await listCalls({ task_id: task.task_id, limit: 100, page: 1 });
    expect(new Set(list.items.map((call) => call.kind))).toEqual(new Set(["api", "function", "match"]));
    expect(list.items.every((call) => call.trace_id === trace)).toBe(true);
    const api = list.items.find((call) => call.kind === "api")!;
    const creator = list.items.find((call) => call.name === "createMatchTask")!;
    const worker = list.items.find((call) => call.name === "processJob(match)")!;
    const match = list.items.find((call) => call.kind === "match")!;
    expect(creator.parent_span_id).toBe(api.id);
    expect(worker.parent_span_id).toBe(creator.id);
    expect(match.parent_span_id).toBe(worker.id);
    expect(api.status).toBe("done"); expect(api.status_code).toBe(202);
    expect(worker.status).toBe("failed"); expect(match.status).toBe("failed");
    expect(match.task_progress).toBe(100);
    const detail = await callDetail(match.id, 0, 1);
    expect(detail.call.input).toMatchObject({ query: "integration-check" });
    expect(detail.call.error).toMatchObject({ code: "model_not_configured" });
    expect(detail.logs).toHaveLength(1); expect(detail.has_more).toBe(true);
    expect((await callDetail(match.id, detail.next_after, 100)).logs.every((log) => log.id > detail.next_after)).toBe(true);
    const complete = await callDetail(match.id, 0, 100);
    expect(complete.logs.map(log => log.message).join("\n")).toContain("开始校验匹配参数");
    expect(complete.logs.at(-1)?.message).toContain("model_not_configured");
    expect(complete.logs.some(log => log.message.includes("检索与相似度筛选完成"))).toBe(false);
    const { getTaskLogs } = await import("@/server/services/task-monitor");
    const taskLogs = await getTaskLogs(task.task_id, { after: 0, limit: 100 });
    expect(taskLogs.items.some(log => log.message.includes("尚未执行检索"))).toBe(true);

    const before = await database.db.select().from(schema.callSpans);
    const { GET } = await import("@/app/api/v1/monitor/calls/route");
    expect((await GET(new Request("http://localhost/api/v1/monitor/calls"))).status).toBe(200);
    expect((await database.db.select().from(schema.callSpans)).length).toBe(before.length);
  });

  test("直接函数调用没有 task 也可查询，过期调用级联清理日志", async () => {
    const { observe, logCall } = await import("@/server/observability/trace");
    await observe("integration.direct", { password: "not-for-logs" }, async () => { await logCall("业务步骤", { token: "not-for-logs" }); return { result: 7 }; });
    const [row] = await database.db.select().from(schema.callSpans).where(eq(schema.callSpans.name, "integration.direct"));
    traceIds.push(row.traceId);
    expect(row.taskId).toBeNull(); expect(row.output).toEqual({ result: 7 });
    expect(JSON.stringify(row.input)).not.toContain("not-for-logs");
    await database.db.update(schema.callSpans).set({ expiresAt: new Date(0) }).where(eq(schema.callSpans.id, row.id));
    const { deleteExpiredCalls } = await import("@/server/observability/store");
    await deleteExpiredCalls();
    expect(await database.db.select().from(schema.callLogs).where(eq(schema.callLogs.spanId, row.id))).toHaveLength(0);
  });
});
