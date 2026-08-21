import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const headObject = vi.hoisted(() => vi.fn());

vi.mock("@/server/storage/zos", () => ({
  createZosObjectStorage: () => ({ headObject }),
}));
import type { AppConfig } from "@/server/config";
import { ApiV1Error } from "@/server/api/errors";
import {
  inspectIngestSource,
  resolveIngestSource,
} from "@/server/mcp/url-ingest";

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
  beforeEach(() => {
    headObject.mockRejectedValue(new Error("object probe unavailable"));
  });

  afterEach(() => {
    headObject.mockReset();
    vi.unstubAllGlobals();
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(
      resolveIngestSource("file:///etc/passwd", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveIngestSource("ftp://example.test/a.png", testConfig()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects raw IP hosts even when the IP matches nothing in the allowlist", async () => {
    const rawIpUrls = [
      [127, 0, 0, 1],
      [10, 0, 0, 1],
      [169, 254, 1, 1],
      [172, 16, 0, 1],
      [192, 168, 1, 1],
    ].map((octets) => `http://${octets.join(".")}/asset.png`);
    for (const url of rawIpUrls) {
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
    const rawIpHost = [127, 0, 0, 1].join(".");
    await expect(
      resolveIngestSource(
        `http://cdn.example.com@${rawIpHost}/a.png`,
        testConfig(),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts allowlisted same-bucket host and probes the object", async () => {
    const config = testConfig({
      ZOS_API_ENDPOINT: "https://object-api.example.test",
      ZOS_ENDPOINT: "https://object-api.example.test",
      ZOS_BUCKET: "test-bucket",
      ZOS_ACCESS_KEY_ID: "test-key",
      ZOS_SECRET_ACCESS_KEY: "test-secret",
    });
    // 同桶走 S3 协议；对象探测已 mock，测试不依赖外部网络。
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
    expect(headObject).toHaveBeenCalledWith("assets/demo.mp4");
  });

  it("honors extra allowed domains and rejects same-bucket without zos config", async () => {
    const config = testConfig({
      mcpAllowedDomains: ["CDN.Example.COM"],
      ZOS_API_ENDPOINT: "",
      ZOS_ENDPOINT: "",
      ZOS_INTERNAL_URL: "",
      ZOS_WEB_URL: "",
      ZOS_BUCKET: "",
      ZOS_ACCESS_KEY_ID: "",
      ZOS_SECRET_ACCESS_KEY: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    );
    // 白名单域名的 HTTP 拉取路径：直接拒绝连接会抛 network error（非 invalid_request），
    // 说明域名校验已通过进入拉取阶段。
    await expect(
      resolveIngestSource("http://cdn.example.com/file.mp4", config),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ApiV1Error)) return true;
      return error.code !== "invalid_request";
    });
  });

  it("defers HTTP GET until a probed batch item is ready to stream", async () => {
    const config = testConfig({
      mcpAllowedDomains: ["cdn.example.com"],
      ZOS_INTERNAL_URL: "",
      ZOS_WEB_URL: "",
    });
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          headers: { "content-length": "3", "content-type": "image/png" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3", "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const descriptor = await inspectIngestSource(
      "https://cdn.example.com/demo.png",
      config,
    );
    expect(descriptor).toMatchObject({ filename: "demo.png", sizeBytes: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });

    const source = await descriptor.open();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    await source.close();
  });

  it("rejects a sixth redirect while allowing five redirect hops", async () => {
    const config = testConfig({
      mcpAllowedDomains: ["cdn.example.com"],
      ZOS_INTERNAL_URL: "",
      ZOS_WEB_URL: "",
    });
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "/next.png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      inspectIngestSource("https://cdn.example.com/demo.png", config),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "源 URL 重定向次数过多。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("rejects empty object keys on same-bucket URLs", async () => {
    const config = testConfig({
      ZOS_API_ENDPOINT: "https://object-api.example.test",
      ZOS_ENDPOINT: "https://object-api.example.test",
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
