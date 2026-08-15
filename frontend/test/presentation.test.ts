import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  friendlyServerApiError,
} from "../src/lib/api-errors";
import { apiFailureMessage, decodeApiResponse } from "../src/lib/api-response";
import { groupDisplayTags } from "../src/lib/asset-tags";
import { withUserScope } from "../src/lib/user-scope";

test("image detail groups category:value tags like the legacy UI", () => {
  assert.deepEqual(groupDisplayTags([
    "scene:海边",
    "scene:日落",
    "无分类标签",
  ]), [
    ["scene", [
      { category: "scene", value: "海边", raw: "scene:海边" },
      { category: "scene", value: "日落", raw: "scene:日落" },
    ]],
    ["custom", [
      { category: "custom", value: "无分类标签", raw: "无分类标签" },
    ]],
  ]);
});

test("navigation retains user_id while changing pages and query parameters", () => {
  assert.equal(withUserScope("/", " user-001 "), "/?user_id=user-001");
  assert.equal(withUserScope("/upload", "user-001"), "/upload?user_id=user-001");
  assert.equal(
    withUserScope("/?view=pending", "user-001"),
    "/?view=pending&user_id=user-001",
  );
  assert.equal(withUserScope("/upload?user_id=old", "user-001"), "/upload?user_id=user-001");
  assert.equal(withUserScope("/upload", ""), "/upload");
});

test("server API uses the agreed one-minute timeout and friendly errors", () => {
  assert.equal(BACKEND_REQUEST_TIMEOUT_MS, 60_000);
  assert.equal(
    friendlyServerApiError(new DOMException("raw timeout", "TimeoutError")).message,
    "后端响应超时，请稍后重试。",
  );
  assert.equal(
    friendlyServerApiError(new DOMException("raw abort", "AbortError")).message,
    "请求已取消，请稍后重试。",
  );
});

test("browser API converts a plain-text proxy 500 into a useful error", async () => {
  const decoded = await decodeApiResponse(new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain" },
  }));
  assert.equal(decoded.invalidJson, true);
  assert.equal(
    apiFailureMessage(decoded.payload, 500, decoded.invalidJson),
    "后端服务暂时不可用，请稍后重试（HTTP 500）。",
  );
});

test("browser API preserves structured backend error messages", async () => {
  const decoded = await decodeApiResponse(new Response(JSON.stringify({
    error: { code: "invalid_request", message: "上传清单无效。" },
  }), { status: 400 }));
  assert.equal(decoded.invalidJson, false);
  assert.equal(
    apiFailureMessage(decoded.payload, 400, decoded.invalidJson),
    "上传清单无效。",
  );
});
