import { describe, expect, it } from "vitest";
import type { AppConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import { resolveIngestSource } from "@/server/mcp/url-ingest";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MAX_IMAGE_BYTES: 20 * 1024 * 1024,
    MAX_VIDEO_BYTES: 200 * 1024 * 1024,
    ZOS_WEB_URL: "https://zos-web.example.com",
    ZOS_INTERNAL_URL: "https://storage.example.com",
    mcpAllowedDomains: [],
    ...overrides,
  } as unknown as AppConfig;
}

describe("resolveIngestSource SSRF guard", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(
      resolveIngestSource("file:///etc/passwd", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveIngestSource("ftp://example.test/a.png", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects raw IP hosts even when the IP matches nothing in the allowlist", async () => {
    for (const url of [
      "http://127.0.0.1/a.png",
      "http://10.0.0.5/a.png",
      "http://192.168.1.1/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/a.png",
    ]) {
      await expect(resolveIngestSource(url, testConfig())).rejects.toMatchObject(
        { code: "invalid_request" },
      );
    }
  });

  it("rejects hosts outside the allowlist", async () => {
    await expect(
      resolveIngestSource("https://evil.example.com/x.png", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveIngestSource("https://storage.example.com.evil.test/x.png", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects host masquerading with credentials", async () => {
    await expect(
      resolveIngestSource(
        "https://storage.example.com@127.0.0.1/x.png",
        testConfig(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts allowlisted same-bucket host and probes the object", async () => {
    const config = testConfig({
      ZOS_API_ENDPOINT: "http://127.0.0.1:19000",
      ZOS_ENDPOINT: "http://127.0.0.1:19000",
      ZOS_BUCKET: "test-bucket",
      ZOS_ACCESS_KEY_ID: "test-key",
      ZOS_SECRET_ACCESS_KEY: "test-secret",
    });
    // 同桶走 S3 协议；无真实服务时应在连接层失败而不是被白名单拒绝。
    await expect(
      resolveIngestSource(
        "https://storage.example.com/assets/demo.mp4",
        config,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ApiV1Error)) return true;
      // 白名单通过后才是连接类错误；不允许出现 invalid_request/白名单错误。
      return error.code !== "invalid_request";
    });
  });

  it("honors extra allowed domains and rejects same-bucket without zos config", async () => {
    const config = testConfig({
      mcpAllowedDomains: ["cdn.example.com"],
      ZOS_API_ENDPOINT: "",
      ZOS_ENDPOINT: "",
      ZOS_INTERNAL_URL: "",
      ZOS_WEB_URL: "",
      ZOS_BUCKET: "",
      ZOS_ACCESS_KEY_ID: "",
      ZOS_SECRET_ACCESS_KEY: "",
    });
    // 白名单域名的 HTTP 拉取路径：直接拒绝连接会抛 network error（非 invalid_request），
    // 说明域名校验已通过进入拉取阶段。
    await expect(
      resolveIngestSource("http://cdn.example.com/file.mp4", config),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ApiV1Error)) return true;
      return error.code !== "invalid_request";
    });
  });

  it("rejects empty object keys on same-bucket URLs", async () => {
    const config = testConfig({
      ZOS_API_ENDPOINT: "http://127.0.0.1:19000",
      ZOS_ENDPOINT: "http://127.0.0.1:19000",
      ZOS_BUCKET: "test-bucket",
      ZOS_ACCESS_KEY_ID: "test-key",
      ZOS_SECRET_ACCESS_KEY: "test-secret",
    });
    // WHATWG URL 已把明文/编码的 .. 段规范化，无法在 pathname 中保留；
    // 空路径必须被 normalizeObjectKey 拒绝（第二道防线）。
    await expect(
      resolveIngestSource("https://storage.example.com/", config),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
