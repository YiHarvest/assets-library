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

test("仅实时失败时显示顶部提醒并发声，自动收起且不会重复报警", async ({ page }, testInfo) => {
  const tones: string[] = [];
  await page.exposeFunction("recordAlertTone", (type: string) => tones.push(type));
  await page.addInitScript(() => {
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = create.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when) => {
        void (window as unknown as { recordAlertTone: (type: string) => Promise<void> }).recordAlertTone(oscillator.type);
        start(when);
      };
      return oscillator;
    };
  });
  let failed = false;
  let newFailure = false;
  let mutedFailure = false;
  const failureTime = new Date().toISOString();
  await page.route("**/api/v1/monitor/calls?**", (route) => {
    const items = calls.map((call, index) => index < 2 ? { ...call, status: failed ? "failed" : "running", finished_at: failed ? failureTime : null, status_code: index === 0 ? (failed ? 500 : null) : null } : call);
    if (newFailure) items.unshift({ ...calls[0], id: "00000000-0000-4000-8000-000000000008", name: "POST /api/v1/assets", status: "failed", status_code: 400, finished_at: failureTime });
    if (mutedFailure) items.unshift({ ...calls[0], id: "00000000-0000-4000-8000-000000000009", name: "POST /api/v1/materials", status: "failed", status_code: 500, finished_at: failureTime });
    return route.fulfill({ json: { items, total: items.length, page: 1, has_more: false } });
  });
  await page.goto(monitorPath);
  await expect(page.getByRole("table", { name: "统一调用列表" }).getByRole("row")).toHaveCount(4);
  const notice = page.getByRole("alert", { name: "失败通知" });
  await expect(notice).toHaveCount(0); // The existing failed Match is history.
  await page.screenshot({ path: testInfo.outputPath("monitor-without-alert.png"), fullPage: true });
  expect(tones).toHaveLength(0);
  await page.getByRole("heading", { name: "统一调用监控", exact: true }).click();
  expect(tones).toHaveLength(0); // User activation must never audition a sound.

  failed = true;
  await expect(notice).toContainText("2 条调用失败"); // Automatic polling, no manual refresh.
  await expect(notice).toContainText("HTTP 500");
  await expect(notice.locator("time").first()).toHaveAttribute("datetime", failureTime);
  await expect.poll(() => tones.length).toBe(2); // One sound for the whole batch.
  expect(tones).toEqual(["sine", "sine"]);
  const box = await notice.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56); // Keep the site navigation accessible.
  expect(box!.y).toBeLessThan(100);
  expect(Math.abs(box!.x + box!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
  expect(box!.width).toBeLessThanOrEqual(460); // Keep a compact card instead of a full-width banner.
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  await page.screenshot({ path: testInfo.outputPath("failure-alert-desktop.png"), fullPage: true });
  await expect(notice).toHaveCount(0, { timeout: 10_000 }); // Repeated polling must not reset its timer.
  expect(tones).toHaveLength(2);

  newFailure = true;
  await expect(notice).toContainText("POST /api/v1/assets");
  await expect.poll(() => tones.length).toBe(4);
  await notice.getByRole("button", { name: "静音提醒", exact: true }).click();
  await expect(notice.getByRole("button", { name: "取消静音" })).toHaveAttribute("aria-pressed", "true");
  mutedFailure = true;
  await expect(notice).toContainText("POST /api/v1/materials");
  expect(tones).toHaveLength(4);
  await notice.getByRole("button", { name: "关闭失败提醒" }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("kind=function")),
    page.getByRole("button", { name: "Function", exact: true }).click(),
  ]);
  await expect(notice).toHaveCount(0); // Changing filters does not replay history.
});

test("新失败在详情抽屉内也能提示，移动端和暗色主题可用", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("theme-mode", "dark"));
  let items = calls;
  await page.route("**/api/v1/monitor/calls?**", (route) => route.fulfill({ json: { items, total: items.length, page: 1, has_more: false } }));
  await page.goto(`${monitorPath}?span_id=${calls[0].id}`);
  const dialog = page.getByRole("dialog", { name: "调用详情" });
  await expect(dialog.getByRole("heading", { name: calls[0].name, exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "统一调用列表", includeHidden: true }).getByRole("row", { includeHidden: true })).toHaveCount(4);
  items = calls.map((call, index) => index === 1 ? { ...call, status: "failed", finished_at: new Date().toISOString() } : call);
  const notice = dialog.getByRole("alert", { name: "失败通知" });
  await expect(notice.getByRole("heading", { name: "调用失败", exact: true })).toBeVisible();
  await expect(notice).toContainText("createMatchTask");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await notice.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56); // Do not cover the drawer's close action.
  expect(box!.y).toBeLessThan(100);
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(382);
  await page.screenshot({ path: testInfo.outputPath("failure-alert-mobile-dark.png"), fullPage: true });
  await notice.getByRole("button", { name: "查看失败详情：createMatchTask" }).click();
  await expect(dialog.getByRole("heading", { name: "createMatchTask", exact: true })).toBeVisible();
  await expect(page.getByRole("alert", { name: "失败通知" })).toHaveCount(0);
});

test("任务失败展示错误原因，音频不可用时仍有文字提醒", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioContext", { value: undefined });
  });
  let failed = false;
  const failureTime = new Date().toISOString();
  await page.route("**/api/v1/tasks?**", (route) => route.fulfill({ json: {
    items: [{ ...task, status: failed ? "failed" : "running", user_id: null, error_message: failed ? "连接分镜服务超时" : null, finished_at: failed ? failureTime : null, updated_at: now }],
    total: 1, page: 1, has_more: false, counts: { queued: 0, running: failed ? 0 : 1, done: 0, failed: failed ? 1 : 0 },
  } }));
  await page.goto(`${monitorPath}?view=tasks`);
  await expect(page.getByRole("table", { name: "任务监控列表" }).getByRole("row")).toHaveCount(2);
  await page.getByRole("heading", { name: "任务监控", exact: true }).click();
  await expect(page.getByRole("alert", { name: "失败通知" })).toHaveCount(0);
  failed = true;
  const notice = page.getByRole("alert", { name: "失败通知" });
  await expect(notice.getByRole("heading", { name: "任务失败", exact: true })).toBeVisible();
  await expect(notice).toContainText("连接分镜服务超时");
  await expect(notice).toContainText("当前浏览器无法播放提示音");
  await expect(notice.getByRole("button", { name: "提示音不可用" })).toBeDisabled();
  await expect(notice.locator("time")).toHaveAttribute("datetime", failureTime);
  await page.screenshot({ path: testInfo.outputPath("failure-alert-task.png"), fullPage: true });
  await notice.getByRole("button", { name: "查看失败详情：素材匹配任务" }).click();
  await expect(page.getByRole("dialog", { name: "任务详情" })).toBeVisible();
  await expect(page.getByRole("alert", { name: "失败通知" })).toHaveCount(0);
});

test.describe("浏览器限制下的失败提示音", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const probe = window as unknown as { alertAudio: AudioContext; alertTones: Array<{ running: boolean; visible: boolean }>; alertPeak: number; holdAudioUntilGesture?: boolean };
      probe.alertTones = [];
      probe.alertPeak = 0;
      let activated = false;
      window.addEventListener("click", (event) => { if (event.isTrusted) activated = true; }, true);
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor() {
          super();
          probe.alertAudio = this;
          if (probe.holdAudioUntilGesture) void super.suspend();
        }
        resume() {
          // Headless autoplay policies vary. Simulate denied permission while
          // retaining native audio nodes and the real output signal.
          if (probe.holdAudioUntilGesture && !activated) {
            return new Promise<void>((resolve, reject) => {
              window.addEventListener("click", () => { super.resume().then(resolve, reject); }, { once: true });
            });
          }
          return super.resume();
        }
        createOscillator() {
          const oscillator = super.createOscillator();
          const start = oscillator.start.bind(oscillator);
          oscillator.start = (when) => {
            probe.alertTones.push({ running: this.state === "running", visible: Boolean(document.querySelector('[role="alert"][aria-label="失败通知"]')) });
            start(when);
          };
          return oscillator;
        }
        createGain() {
          const gain = super.createGain();
          const analyser = this.createAnalyser();
          gain.connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          const timer = window.setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            for (const value of samples) probe.alertPeak = Math.max(probe.alertPeak, Math.abs(value));
          }, 20);
          window.setTimeout(() => { clearInterval(timer); analyser.disconnect(); }, 800);
          return gain;
        }
      };
    });
  });

  test("音频暂停后自动恢复，弹框出现时实际产生音频信号", async ({ page }) => {
    let failed = false;
    await page.route("**/api/v1/monitor/calls?**", (route) => route.fulfill({ json: {
      items: calls.map((call, index) => index === 0 && failed ? { ...call, status: "failed", status_code: 500 } : call),
      total: calls.length, page: 1, has_more: false,
    } }));
    await page.goto(monitorPath);
    await expect(page.getByRole("table", { name: "统一调用列表" }).getByRole("row")).toHaveCount(4);
    await page.getByRole("heading", { name: "统一调用监控", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertAudio: AudioContext }).alertAudio.state)).toBe("running");
    await page.evaluate(() => (window as unknown as { alertAudio: AudioContext }).alertAudio.suspend());
    failed = true;
    const notice = page.getByRole("alert", { name: "失败通知" });
    await expect(notice).toContainText("POST /api/v1/match");
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertTones: unknown[] }).alertTones.length)).toBe(2);
    expect(await page.evaluate(() => (window as unknown as { alertTones: unknown[] }).alertTones)).toEqual([
      { running: true, visible: true }, { running: true, visible: true },
    ]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertPeak: number }).alertPeak)).toBeGreaterThan(0.1);
    await expect(notice.getByRole("button", { name: "静音提醒", exact: true })).toBeVisible();
  });

  test("播放受限时明确提示，开启后试听一次且后续任务失败自动发声", async ({ page }, testInfo) => {
    let failureCount = 0;
    await page.addInitScript(() => { (window as unknown as { holdAudioUntilGesture: boolean }).holdAudioUntilGesture = true; });
    await page.route("**/api/v1/tasks?**", (route) => route.fulfill({ json: {
      items: [0, 1].map((index) => ({ ...task, task_id: index ? traceId : taskId, status: index < failureCount ? "failed" : "running", user_id: null, error_message: index < failureCount ? "请配置 embedding" : null, updated_at: now })),
      total: 2, page: 1, has_more: false, counts: { queued: 0, running: 2 - failureCount, done: 0, failed: failureCount },
    } }));
    await page.goto(`${monitorPath}?view=tasks`);
    await expect(page.getByRole("table", { name: "任务监控列表" }).getByRole("row")).toHaveCount(3);
    failureCount = 1;
    const notice = page.getByRole("alert", { name: "失败通知" });
    await expect(notice).toContainText("声音尚未启用");
    expect(await page.evaluate(() => (window as unknown as { alertTones: unknown[] }).alertTones.length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("failure-alert-sound-blocked.png"), fullPage: true });
    await page.waitForTimeout(650); // An expired resume attempt must not replay alongside the explicit audition.
    await notice.getByRole("button", { name: "开启声音并试听", exact: true }).click();
    await expect(notice.getByRole("button", { name: "静音提醒", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertTones: unknown[] }).alertTones.length)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertPeak: number }).alertPeak)).toBeGreaterThan(0.1);
    failureCount = 2;
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertTones: unknown[] }).alertTones.length)).toBe(4);
    await expect(notice).not.toContainText("声音尚未启用");
  });
});
