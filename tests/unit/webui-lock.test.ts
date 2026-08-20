import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebUiSession,
  isProtectedWebUiPath,
  readCookie,
  readWebUiLockConfig,
  safeWebUiReturnPath,
  stripAppBasePath,
  verifyWebUiSession,
  WEBUI_LOCK_SESSION_SECONDS,
} from "@/server/auth/webui-lock";
import {
  readBearerCredential,
  webUiLockKeyMatches,
} from "@/server/auth/webui-lock-node";

const key = "a".repeat(64);

describe("WebUI lock primitives", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is disabled only when dev has no key", () => {
    expect(readWebUiLockConfig({ APP_MODE: "dev" })).toEqual({
      appMode: "dev",
      enabled: false,
      key: undefined,
    });
    expect(readWebUiLockConfig({ APP_MODE: "dev", WEBUI_LOCK_KEY: key })).toEqual({
      appMode: "dev",
      enabled: true,
      key,
    });
  });

  it("fails closed for missing or weak production credentials", () => {
    expect(() => readWebUiLockConfig({ APP_MODE: "prd" })).toThrow(
      "生产模式必须配置 WEBUI_LOCK_KEY",
    );
    expect(() =>
      readWebUiLockConfig({ APP_MODE: "prd", WEBUI_LOCK_KEY: "short" }),
    ).toThrow("至少需要 32 个字符");
  });

  it("signs expiring sessions and rejects tampering or key rotation", async () => {
    const now = Date.UTC(2026, 7, 19);
    const session = await createWebUiSession(key, now);

    expect(await verifyWebUiSession(session, key, now)).toBe(true);
    expect(await verifyWebUiSession(`${session}x`, key, now)).toBe(false);
    expect(await verifyWebUiSession(session, "b".repeat(64), now)).toBe(false);
    expect(
      await verifyWebUiSession(
        session,
        key,
        now + WEBUI_LOCK_SESSION_SECONDS * 1_000,
      ),
    ).toBe(false);
  });

  it("classifies only the selected page surface after stripping basePath", () => {
    const env = { NEXT_PUBLIC_BASE_PATH: "/feisu/assets-library" };
    expect(stripAppBasePath("/feisu/assets-library/upload", env)).toBe("/upload");
    expect(isProtectedWebUiPath("/assets/asset-1")).toBe(true);
    expect(isProtectedWebUiPath("/api/v1/assets/query")).toBe(false);
    expect(isProtectedWebUiPath("/lock")).toBe(false);
    expect(
      safeWebUiReturnPath("/feisu/assets-library/docs?view=api", env),
    ).toBe("/feisu/assets-library/docs?view=api");
    expect(safeWebUiReturnPath("/", env)).toBe("/feisu/assets-library/");
    expect(safeWebUiReturnPath("/upload?source=lock", env)).toBe(
      "/feisu/assets-library/upload?source=lock",
    );
    expect(safeWebUiReturnPath("/assets/asset-1", env)).toBe(
      "/feisu/assets-library/assets/asset-1",
    );
    expect(safeWebUiReturnPath("https://evil.example/", env)).toBe(
      "/feisu/assets-library/",
    );
    expect(safeWebUiReturnPath("/api/v1/assets/query", env)).toBe(
      "/feisu/assets-library/",
    );
  });

  it("parses credentials without exposing prefix or timing shortcuts", () => {
    expect(readCookie("other=1; session=value%2Epart", "session")).toBe(
      "value.part",
    );
    expect(readBearerCredential(`Bearer ${key}`)).toBe(key);
    expect(readBearerCredential(`Basic ${key}`)).toBeUndefined();
    expect(webUiLockKeyMatches(key, key)).toBe(true);
    expect(webUiLockKeyMatches("wrong", key)).toBe(false);
  });
});
