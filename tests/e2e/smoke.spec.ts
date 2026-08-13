import { expect, test } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZGroAAAAASUVORK5CYII=",
  "base64",
);

test("overview and upload pages expose the MVP scope", async ({ page }) => {
  test.setTimeout(90_000);
  // 首页首次请求包含 Next 冷编译和测试库查询，单独给予启动时间；上传用例
  // 直接进入 /upload，不再被与其无关的首页查询阻塞。
  await page.goto("/", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "素材库" })).toBeVisible();
  await expect(
    page.getByText("已经完成审核并正式入库的素材。"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "待入库", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "已入库", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "按标签搜索已入库素材" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "主题：跟随系统" }).click();
  await page.getByRole("button", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "主题：暗色" }).click();
  await page.getByRole("button", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(245, 245, 247)",
  );
  await expect(
    page.getByPlaceholder("搜索标签、场景或风格"),
  ).toBeVisible();
  await page.getByRole("link", { name: "列表视图" }).click();
  await expect(page).toHaveURL(/layout=list/);
  await page.getByRole("link", { name: "画廊视图" }).click();
  await expect(page).not.toHaveURL(/layout=list/);
  await page.getByRole("link", { name: "待入库", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "按标签搜索已入库素材" }),
  ).toHaveCount(0);
  await Promise.all([
    page.waitForURL(/\/upload$/, { timeout: 20_000 }),
    page.getByRole("link", { name: /上传素材/ }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "上传素材" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/提取 1–5 张关键帧/)).toBeVisible();
  await expect(page.getByText(/支持一次选择多个本地素材并逐个上传/)).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveAttribute(
    "accept",
    /video\/mp4/,
  );
  await expect(page.locator('input[type="file"]')).toHaveAttribute("multiple");

  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: png },
    { name: "second.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.getByText("first.png", { exact: true })).toBeVisible();
  await expect(page.getByText("second.png", { exact: true })).toBeVisible();
  await expect(page.getByLabel("first.png 预览")).toBeHidden();
  await page.getByText("first.png", { exact: true }).hover();
  await expect(page.getByLabel("first.png 预览")).toBeVisible();
  await expect(page.getByAltText("first.png 预览")).toBeVisible();
  await expect(page.getByLabel("second.png 预览")).toBeHidden();
  await expect(page.getByTestId("upload-dropzone")).toHaveCSS(
    "height",
    "256px",
  );
  const listCanScroll = await page
    .getByRole("list", { name: "上传素材列表" })
    .evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(listCanScroll).toBe(true);
});

test("submits one to five images through one multipart request", async ({ page }) => {
  const taskId = "00000000-0000-4000-8000-000000000010";
  const itemIds = Array.from(
    { length: 5 },
    (_, index) => `00000000-0000-4000-8000-00000000001${index + 1}`,
  );
  let multipartCount = 0;
  let pollCount = 0;
  const task = (done = false) => ({
    task_id: taskId,
    task_type: "upload",
    status: done ? "done" : "running",
    phase: done ? "finished" : "validating",
    progress_percent: done ? 100 : 0,
    total_files: 5,
    done_files: done ? 5 : 0,
    failed_files: 0,
    callback_url: null,
    result: null,
    files: itemIds.map((itemId, index) => ({
      item_id: itemId,
      filename: `${index + 1}.png`,
      media_type: "image",
      status: done ? "done" : "queued",
      phase: done ? "finished" : "validating",
      received_bytes: png.length,
      total_bytes: png.length,
      progress_percent: 100,
      asset_ids: done
        ? [`10000000-0000-4000-8000-00000000001${index}`]
        : [],
      error: null,
    })),
    error: null,
    created_at: "2026-08-12T12:00:00+08:00",
    started_at: null,
    finished_at: done ? "2026-08-12T12:00:01+08:00" : null,
    expires_at: null,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/v1/uploads") {
      multipartCount += 1;
      const payload = request.postDataBuffer()?.toString("utf8") ?? "";
      expect(payload.match(/name="files"/g)).toHaveLength(5);
      expect(request.headerValue("content-type")).resolves.toMatch(
        /^multipart\/form-data; boundary=/,
      );
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(task()),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/tasks" &&
      url.searchParams.get("task_id") === taskId
    ) {
      pollCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(task(true)),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/upload");
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 5 }, (_, index) => ({
      name: `${index + 1}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await page.getByRole("button", { name: "开始上传" }).click();

  await expect.poll(() => multipartCount).toBe(1);
  await expect.poll(() => pollCount).toBeGreaterThan(0);
  await expect(
    page.getByText("本次任务中的素材均已处理完成。"),
  ).toBeVisible();
});

test("submits exactly one video and polls the static task endpoint", async ({
  page,
}) => {
  const taskId = "00000000-0000-4000-8000-000000000030";
  const itemId = "00000000-0000-4000-8000-000000000031";
  const video = Buffer.from("mock mp4 bytes");
  let multipartCount = 0;
  let pollCount = 0;
  const task = (done = false) => ({
    task_id: taskId,
    task_type: "upload",
    status: done ? "done" : "running",
    phase: done ? "finished" : "splitting",
    progress_percent: done ? 100 : 50,
    total_files: 1,
    done_files: done ? 1 : 0,
    failed_files: 0,
    callback_url: null,
    result: null,
    files: [
      {
        item_id: itemId,
        filename: "scene.mp4",
        media_type: "video",
        status: done ? "done" : "running",
        phase: done ? "finished" : "splitting",
        received_bytes: video.length,
        total_bytes: video.length,
        progress_percent: done ? 100 : 50,
        asset_ids: done
          ? ["10000000-0000-4000-8000-000000000030"]
          : [],
        error: null,
      },
    ],
    error: null,
    created_at: "2026-08-13T10:00:00+08:00",
    started_at: "2026-08-13T10:00:00+08:00",
    finished_at: done ? "2026-08-13T10:00:01+08:00" : null,
    expires_at: null,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/v1/uploads") {
      multipartCount += 1;
      const payload = request.postDataBuffer()?.toString("utf8") ?? "";
      expect(payload.match(/name="files"/g)).toHaveLength(1);
      expect(payload).toContain('filename="scene.mp4"');
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(task()),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/tasks" &&
      url.searchParams.get("task_id") === taskId
    ) {
      pollCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(task(true)),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/upload");
  await page.locator('input[type="file"]').setInputFiles({
    name: "scene.mp4",
    mimeType: "video/mp4",
    buffer: video,
  });
  await page.getByRole("button", { name: "开始上传" }).click();

  await expect.poll(() => multipartCount).toBe(1);
  await expect.poll(() => pollCount).toBeGreaterThan(0);
  await expect(page.getByText("本次任务中的素材均已处理完成。")).toBeVisible();
});

test("shows an asynchronous media validation error without requiring hover", async ({
  page,
}) => {
  const failureMessage =
    "图片已损坏、无法读取，或不是可转换的 JPEG、PNG、WebP 图片。";
  const taskId = "00000000-0000-4000-8000-000000000020";
  const itemId = "00000000-0000-4000-8000-000000000021";
  const fileSize = Buffer.from("not an image").length;
  const task = (failed = false) => ({
    task_id: taskId,
    task_type: "upload",
    status: failed ? "failed" : "running",
    phase: failed ? "finished" : "validating",
    progress_percent: failed ? 100 : 0,
    total_files: 1,
    done_files: 0,
    failed_files: failed ? 1 : 0,
    callback_url: null,
    result: null,
    files: [
      {
        item_id: itemId,
        filename: "corrupt.png",
        media_type: "image",
        status: failed ? "failed" : "queued",
        phase: failed ? "finished" : "validating",
        received_bytes: fileSize,
        total_bytes: fileSize,
        progress_percent: failed ? 100 : 0,
        asset_ids: [],
        error: failed
          ? {
              code: "corrupt_file",
              message: failureMessage,
              details: [
                {
                  segment_index: 1,
                  size_bytes: 10 * 1024 * 1024,
                },
              ],
            }
          : null,
      },
    ],
    error: failed ? { code: "corrupt_file", message: failureMessage } : null,
    created_at: "2026-08-12T12:00:00+08:00",
    started_at: null,
    finished_at: failed ? "2026-08-12T12:00:01+08:00" : null,
    expires_at: null,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/v1/uploads") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(task()),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/tasks" &&
      url.searchParams.get("task_id") === taskId
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(task(true)),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/upload");
  await page.locator('input[type="file"]').setInputFiles({
    name: "corrupt.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await page.getByRole("button", { name: "开始上传" }).click();

  const item = page.getByRole("listitem").filter({ hasText: "corrupt.png" });
  await expect(
    item.getByText("上传或处理失败", { exact: true }),
  ).toBeVisible();
  await expect(item.getByRole("alert")).toContainText(failureMessage);
  await expect(item.getByRole("alert")).toContainText(
    "切片 2（10.0 MiB）",
  );
  await expect(
    page.getByText("1 个素材上传或处理失败，请查看原因。"),
  ).toBeVisible();
});
