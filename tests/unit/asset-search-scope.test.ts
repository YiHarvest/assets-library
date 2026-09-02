import { describe, expect, it } from "vitest";
import {
  scopeForAssetQuery,
  scopeForRepository,
} from "@/server/modules/assets/asset-service";

describe("asset search scope", () => {
  it.each(["AI", "ai", "AIGC", "人工智能"])(
    "expands public %s search to all visible owners",
    (keyword) => {
      expect(
        scopeForAssetQuery({
          keywords: [keyword],
          filter: { user_scope: { mode: "public" } },
        }, { expandPublicBroadAi: true }),
      ).toEqual({ includeAllUsers: true });
    },
  );

  it("keeps non-AI public searches in the public library", () => {
    expect(
      scopeForAssetQuery({
        keywords: ["城市"],
        filter: { user_scope: { mode: "public" } },
      }, { expandPublicBroadAi: true }),
    ).toEqual({});
  });

  it("does not broaden an explicitly selected user", () => {
    expect(
      scopeForAssetQuery({
        keywords: ["AI"],
        filter: { user_scope: { mode: "user", user_id: "747" } },
      }, { expandPublicBroadAi: true }),
    ).toEqual({ userId: "747" });
    expect(scopeForRepository({ mode: "public" })).toEqual({});
  });

  it("keeps MCP-style calls in public scope unless the REST switch is explicit", () => {
    expect(
      scopeForAssetQuery({
        keywords: ["AI"],
        filter: { user_scope: { mode: "public" } },
      }),
    ).toEqual({});
  });
});
