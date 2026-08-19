import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  createWebUiSession,
  WEBUI_LOCK_COOKIE_NAME,
} from "@/server/auth/webui-lock";

const key = "c".repeat(64);
const origin = "https://media.example.com";
const basePath = "/feisu/assets-library";

describe("WebUI lock middleware", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leaves local development unchanged when no key is configured", async () => {
    vi.stubEnv("APP_MODE", "dev");
    vi.stubEnv("WEBUI_LOCK_KEY", "");
    const response = await middleware(new NextRequest(`${origin}/upload`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("returns 503 instead of opening production pages when configuration is missing", async () => {
    vi.stubEnv("APP_MODE", "prd");
    vi.stubEnv("WEBUI_LOCK_KEY", "");
    const response = await middleware(new NextRequest(`${origin}/`));
    expect(response.status).toBe(503);
  });

  it("redirects protected prefixed pages to the prefixed lock page", async () => {
    enableLock();
    const response = await middleware(
      new NextRequest(`${origin}${basePath}/assets/asset-1?user_id=user-7`),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe(`${basePath}/lock`);
    expect(location.searchParams.get("next")).toBe(
      `${basePath}/assets/asset-1?user_id=user-7`,
    );
  });

  it("accepts a valid signed session cookie", async () => {
    enableLock();
    const session = await createWebUiSession(key);
    const response = await middleware(
      new NextRequest(`${origin}${basePath}/docs`, {
        headers: { cookie: `${WEBUI_LOCK_COOKIE_NAME}=${session}` },
      }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("never applies the page lock to the stable business API facade", async () => {
    enableLock();
    for (const pathname of [
      `${basePath}/api/v1/uploads`,
      `${basePath}/api/v1/tasks/00000000-0000-4000-8000-000000000001`,
      `${basePath}/api/v1/assets/query`,
      `${basePath}/api/v1/media/00000000-0000-4000-8000-000000000001`,
    ]) {
      const response = await middleware(new NextRequest(`${origin}${pathname}`));
      expect(response.headers.get("x-middleware-next"), pathname).toBe("1");
    }
  });
});

function enableLock() {
  vi.stubEnv("APP_MODE", "prd");
  vi.stubEnv("WEBUI_LOCK_KEY", key);
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
}
