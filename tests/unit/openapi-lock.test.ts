import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getOpenApi } from "@/app/api/v1/openapi/route";
import { POST as unlock } from "@/app/api/auth/unlock/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import {
  createWebUiSession,
  WEBUI_LOCK_COOKIE_NAME,
} from "@/server/auth/webui-lock";

const key = "d".repeat(64);
const openApiUrl = "http://localhost/api/v1/openapi";

describe("OpenAPI and unlock authorization", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows OpenAPI in dev when the page lock is disabled", async () => {
    vi.stubEnv("APP_MODE", "dev");
    vi.stubEnv("WEBUI_LOCK_KEY", "");
    expect((await getOpenApi(new Request(openApiUrl))).status).toBe(200);
  });

  it("requires authorization only for OpenAPI when the lock is enabled", async () => {
    enableLock();
    const response = await getOpenApi(new Request(openApiUrl));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("accepts the shared key through Bearer authorization", async () => {
    enableLock();
    const response = await getOpenApi(
      new Request(openApiUrl, {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("openapi: 3.1.0");
  });

  it("accepts a signed browser session", async () => {
    enableLock();
    const session = await createWebUiSession(key);
    const response = await getOpenApi(
      new Request(openApiUrl, {
        headers: { cookie: `${WEBUI_LOCK_COOKIE_NAME}=${session}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("sets a scoped secure HttpOnly cookie after a valid unlock", async () => {
    enableLock();
    const body = new URLSearchParams({
      key,
      next: "/feisu/assets-library/docs",
    });
    const response = await unlock(
      new Request("https://media.example.com/feisu/assets-library/api/auth/unlock", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://media.example.com/feisu/assets-library/docs",
    );
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${WEBUI_LOCK_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/feisu/assets-library");
  });

  it("clears the scoped session on logout", () => {
    enableLock();
    const response = logout(
      new Request("https://media.example.com/feisu/assets-library/api/auth/logout", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://media.example.com/feisu/assets-library/lock",
    );
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${WEBUI_LOCK_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/feisu/assets-library");
  });
});

function enableLock() {
  vi.stubEnv("APP_MODE", "prd");
  vi.stubEnv("WEBUI_LOCK_KEY", key);
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/feisu/assets-library");
}
