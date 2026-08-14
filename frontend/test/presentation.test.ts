import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  friendlyServerApiError,
} from "../src/lib/api-errors";
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
