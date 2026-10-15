import { expect, test } from "@playwright/test";

const monitorPath = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/monitor`;
const traceId = "00000000-0000-4000-8000-000000000090";
const taskId = "00000000-0000-4000-8000-000000000099";
const now = "2026-10-15T12:00:00.000+08:00";
const calls = ["api", "function", "match"].map((kind, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`, trace_id: traceId,
  parent_span_id: index ? "00000000-0000-4000-8000-000000000001" : null,
  task_id: taskId, kind, name: ["POST /api/v1/match", "createMatchTask", "match"][index],
  status: index === 2 ? "failed" : "done", status_code: index === 0 ? 202 : null,
  duration_ms: 42, started_at: now, finished_at: now,
  task_status: "failed", task_phase: "finished", task_progress: 100,
}));
const task = {
  task_id: taskId, task_type: "match", status: "failed", phase: "finished", progress_percent: 100,
  received_bytes: 0, total_bytes: 0, total_items: 1, done_items: 0, failed_items: 1,
  callback_url: null, result: null, items: [], error: { code: "model_not_configured", message: "请配置 embedding" },
  created_at: now, started_at: now, finished_at: now, expires_at: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/monitor/calls**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").at(-1);
    if (id !== "calls") {
      const call = calls.find((row) => row.id === id)!;
      return route.fulfill({ json: {
        call: { ...call, input: { query: "海边汽车" }, output: call.kind === "api" ? { task_id: taskId } : null,
          error: call.status === "failed" ? { code: "model_not_configured", message: "请配置 embedding" } : null },
        logs: Number(url.searchParams.get("after")) < 1 ? [{ id: 1, level: "info", message: "调用开始。", data: null, created_at: now }] : [],
        next_after: 1, has_more: false,
      } });
    }
    const kind = url.searchParams.get("kind");
    const items = calls.filter((call) => !kind || call.kind === kind);
    return route.fulfill({ json: { items, total: items.length, page: 1, has_more: false } });
  });
  await page.route("**/api/v1/tasks**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/monitor")) return route.fulfill({ json: { task, input: { query: "海边汽车" }, output: task, jobs: [], callbacks: [] } });
    if (url.pathname.endsWith("/logs")) {
      const after = Number(url.searchParams.get("after"));
      const logs = [
        { id: 1, level: "info", phase: "validating", message: "开始校验文件。", data: null, created_at: now },
        { id: 2, level: "info", phase: "splitting", message: "开始视频分镜。", data: null, created_at: now },
        { id: 3, level: "error", phase: "splitting", message: "分镜服务请求失败。", data: { error: { code: "scene_detection_failed", message: "连接分镜服务超时" } }, created_at: now },
      ];
      const items = logs.filter(log => log.id > after).slice(0, 2);
      return route.fulfill({ json: { items, next_after: items.at(-1)?.id ?? after, has_more: after === 0 } });
    }
    return route.fulfill({ json: { items: [{ ...task, user_id: null, error_message: "请配置 embedding", updated_at: now }], total: 1, page: 1, has_more: false, counts: { queued: 0, running: 0, done: 0, failed: 1 } } });
  });
});

test("API、Function、Match 在同一列表展示，并可筛选与查看参数日志", async ({ page }, testInfo) => {
  await page.goto(monitorPath);
  const table = page.getByRole("table", { name: "统一调用列表" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByText("POST /api/v1/match", { exact: true })).toBeVisible();
  await expect(table.getByText("createMatchTask", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "查看调用" }).click();
  const dialog = page.getByRole("dialog", { name: "调用详情" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "整个任务", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("调用日志列表")).toContainText("开始视频分镜。");
  await expect(dialog.getByLabel("调用日志列表")).toContainText("连接分镜服务超时");
  await expect(dialog.getByText("开始校验文件。", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "当前调用", exact: true }).click();
  await expect(dialog.getByText("调用开始。", { exact: true })).toHaveCount(1);
  await page.waitForTimeout(2200);
  await expect(dialog.getByText("调用开始。", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "整个任务", exact: true }).click();
  await expect(dialog.getByText("开始视频分镜。", { exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("call-steps.png"), fullPage: true });
  await dialog.getByRole("tab", { name: "入参", exact: true }).click();
  await expect(dialog.getByLabel("调用入参", { exact: true })).toContainText("海边汽车");
  await dialog.getByRole("tab", { name: "错误", exact: true }).click();
  await expect(dialog.getByLabel("调用错误", { exact: true })).toContainText("model_not_configured");
  await page.screenshot({ path: testInfo.outputPath("call-detail.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出记录" }).click();
  expect((await download).suggestedFilename()).toBe(`call-${calls[2].id}.json`);
  await dialog.locator("summary").filter({ hasText: "调用标识与链路" }).click();
  await dialog.getByRole("button", { name: "查看同一 Trace 的全部调用" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Trace ID", { exact: true })).toHaveValue(traceId);
  await expect(table.getByRole("row")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("calls-desktop.png"), fullPage: true });
});

test("同页保留任务进度，并能查看该任务的全部调用", async ({ page }) => {
  await page.goto(`${monitorPath}?task_id=${taskId}`);
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "入参", exact: true }).click();
  await expect(dialog.getByLabel("请求入参", { exact: true })).toContainText("海边汽车");
  await dialog.getByRole("link", { name: "查看此任务关联的 API / Function / Match 调用" }).click();
  await expect(page.getByRole("table", { name: "统一调用列表" })).toBeVisible();
  await expect(page.getByLabel("关联 Task ID", { exact: true })).toHaveValue(taskId);
});

test("直接链接、错误反馈和移动端列表可用", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${monitorPath}?span_id=${calls[0].id}`);
  const dialog = page.getByRole("dialog", { name: "调用详情" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "出参", exact: true }).click();
  await expect(dialog.getByLabel("调用出参", { exact: true })).toContainText(taskId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("calls-mobile-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("calls-mobile.png"), fullPage: true });
  await page.route("**/api/v1/monitor/calls?**", (route) => route.fulfill({ status: 503, json: { error: { message: "测试：暂不可用" } } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "测试：暂不可用" })).toBeVisible();
});


test("暗色主题、日志筛选和任务结果入口保持可用", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("theme-mode", "dark"));
  await page.goto(`${monitorPath}?span_id=${calls[0].id}`);
  const dialog = page.getByRole("dialog", { name: "调用详情" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog.getByLabel("调用日志列表")).toContainText("连接分镜服务超时");
  await dialog.getByLabel("调用日志级别", { exact: true }).selectOption("error");
  await expect(dialog.getByText("开始校验文件。", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("调用日志列表")).toContainText("连接分镜服务超时");
  await page.screenshot({ path: testInfo.outputPath("call-dark.png"), fullPage: true });
  await dialog.getByRole("link", { name: "查看任务结果", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "任务详情" })).toBeVisible();
  await expect(page.getByLabel("执行日志列表")).toContainText("开始视频分镜。");
  await page.screenshot({ path: testInfo.outputPath("task-dark.png"), fullPage: true });
});
