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

  it("sets a root-scoped secure HttpOnly cookie after a valid unlock", async () => {
    enableLock();
    const body = new URLSearchParams({
      key,
      next: "/",
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
      "https://media.example.com/feisu/assets-library/",
    );
    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find(
      (cookie) => cookie.includes(`${WEBUI_LOCK_COOKIE_NAME}=`) &&
        !cookie.includes("Max-Age=0"),
    );
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=lax");
    expect(sessionCookie).toMatch(/(?:^|; )Path=\/(?:;|$)/);
    expect(cookies).toContainEqual(
      expect.stringContaining("Path=/feisu/assets-library"),
    );
    expect(cookies).toContainEqual(expect.stringContaining("Max-Age=0"));
  });

  it("does not share the fallback rate-limit bucket across user agents", async () => {
    enableLock();
    const request = (keyValue: string, userAgent: string) =>
      unlock(
        new Request(
          "https://media.example.com/feisu/assets-library/api/auth/unlock",
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": userAgent,
            },
            body: new URLSearchParams({ key: keyValue, next: "/" }),
          },
        ),
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request("wrong", "rate-limit-agent-a")).status).toBe(303);
    }
    expect((await request(key, "rate-limit-agent-a")).status).toBe(429);
    expect((await request(key, "rate-limit-agent-b")).status).toBe(303);
  });

  it("clears the root-scoped session on logout", () => {
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
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies).toContainEqual(expect.stringMatching(/Path=\/(?:;|$)/));
    expect(cookies).toContainEqual(
      expect.stringContaining("Path=/feisu/assets-library"),
    );
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });
});

function enableLock() {
  vi.stubEnv("APP_MODE", "prd");
  vi.stubEnv("WEBUI_LOCK_KEY", key);
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/feisu/assets-library");
}
