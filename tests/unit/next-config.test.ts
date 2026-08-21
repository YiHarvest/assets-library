import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePublicBasePath } from "../../next.config";

describe("Next public base path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("normalizes missing, repeated, leading, and trailing separators", () => {
    expect(normalizePublicBasePath(undefined)).toBe("");
    expect(normalizePublicBasePath("/")).toBe("");
    expect(normalizePublicBasePath(" //feisu//assets-library// ")).toBe(
      "/feisu/assets-library",
    );
  });

  it("uses the normalized prefix for asset URLs and rewrite sources", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "//feisu//assets-library//");
    vi.resetModules();
    const { default: config } = await import("../../next.config");

    expect(config.assetPrefix).toBe("/feisu/assets-library");
    await expect(config.rewrites!()).resolves.toEqual([
      {
        source: "/feisu/assets-library/:path*",
        destination: "/:path*",
      },
      { source: "/feisu/assets-library", destination: "/" },
    ]);
  });
});
