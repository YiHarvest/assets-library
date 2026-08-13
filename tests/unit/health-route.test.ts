import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collectHealth: vi.fn() }));

vi.mock("@/server/health/service", () => ({
  collectHealth: mocks.collectHealth,
}));

import { GET } from "@/app/health/route";

describe("GET /health", () => {
  beforeEach(() => {
    mocks.collectHealth.mockReset();
  });

  it.each([
    ["ok", 200],
    ["unavailable", 503],
  ] as const)("maps %s to HTTP %i", async (status, expectedStatus) => {
    mocks.collectHealth.mockResolvedValue({
      status,
      checked_at: "2026-08-12T10:17:00.000+08:00",
      services: {
        web: { status: "up" },
        worker: { status: status === "ok" ? "up" : "down" },
        mysql: { status: "up" },
        chroma: { status: "up" },
        scene_detect: { status: "up" },
        zos: { status: "up" },
      },
    });

    const response = await GET();
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status });
  });
});
