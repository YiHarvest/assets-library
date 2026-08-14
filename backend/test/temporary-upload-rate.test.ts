import assert from "node:assert/strict";
import test from "node:test";
import { trustLoopbackProxy } from "../src/common/proxy-trust-policy";
import { TemporaryUploadRateLimitError, TemporaryUploadRateLimiter } from "../src/services/temporary-upload-rate-limiter";

test("轮换user仍命中独立IP桶", () => {
  const limiter = new TemporaryUploadRateLimiter(2, 10);
  limiter.consume("203.0.113.1", "user-a", 0);
  limiter.consume("203.0.113.1", "user-b", 0);
  assert.throws(() => limiter.consume("203.0.113.1", "user-c", 0), (error: unknown) => error instanceof TemporaryUploadRateLimitError && error.dimension === "ip");
});

test("轮换IP仍命中独立user桶且窗口后恢复", () => {
  const limiter = new TemporaryUploadRateLimiter(10, 2);
  limiter.consume("203.0.113.1", "same-user", 0);
  limiter.consume("203.0.113.2", "same-user", 0);
  assert.throws(() => limiter.consume("203.0.113.3", "same-user", 0), (error: unknown) => error instanceof TemporaryUploadRateLimitError && error.dimension === "user");
  assert.doesNotThrow(() => limiter.consume("203.0.113.3", "same-user", 60_000));
});

test("仅信任回环Next代理提供的X-Forwarded-For", () => {
  for (const address of ["127.0.0.1", "127.9.8.7", "::1", "::ffff:127.0.0.1"]) assert.equal(trustLoopbackProxy(address), true);
  for (const address of ["0.0.0.0", "10.0.0.2", "172.17.0.1", "192.168.1.2", "::ffff:10.0.0.2"]) assert.equal(trustLoopbackProxy(address), false);
});
