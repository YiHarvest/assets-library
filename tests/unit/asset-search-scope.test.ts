import { describe, expect, it } from "vitest";
import {
  scopeForAssetQuery,
  scopeForRepository,
} from "@/server/modules/assets/asset-service";

describe("asset search scope", () => {
  it.each(["AI", "ai", "AIGC", "人工智能", "城市"])(
    "keeps public %s searches in the public library",
    (keyword) => {
    expect(
      scopeForAssetQuery({
        keywords: [keyword],
        filter: { user_scope: { mode: "public" } },
      }),
    ).toEqual({});
    },
  );

  it("does not broaden an explicitly selected user", () => {
    expect(
      scopeForAssetQuery({
        keywords: ["AI"],
        filter: { user_scope: { mode: "user", user_id: "747" } },
      }),
    ).toEqual({ userId: "747" });
    expect(scopeForRepository({ mode: "public" })).toEqual({});
  });

  it("maps public exclusion to the dedicated public-only scope", () => {
    expect(scopeForRepository({ mode: "exclude_user", user_id: "747" })).toEqual({
      excludeUserId: "747",
    });
  });
});
