import * as React from "react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  serverApiV1: vi.fn(),
  serverWebUiApi: vi.fn(),
}));

vi.mock("@/lib/server-api-v1", () => apiMocks);

import OverviewPage from "@/app/page";
import { AssetScopeSwitcher } from "@/components/asset-scope-switcher";
import { AssetOverviewGrid } from "@/components/asset-overview-grid";
import AssetDetailPage from "@/app/assets/[id]/page";
import { appUrl } from "@/lib/paths";

function emptyPage(search: {
  mode: "keyword" | "semantic" | "hybrid";
  threshold: number;
  max_score: number | null;
  reason:
    | "matched"
    | "no_candidates"
    | "below_threshold"
    | "semantic_unavailable"
    | "fallback_exhausted";
  message: string | null;
} | null = null) {
  return {
    items: [],
    next_cursor: null,
    has_more: false,
    tag_statistics: null,
    search,
  };
}

function renderedText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (!React.isValidElement<{ children?: ReactNode }>(node)) return "";
  return renderedText(node.props.children);
}

async function renderSearch(tag: string, page = emptyPage()) {
  apiMocks.serverApiV1.mockResolvedValue(page);
  apiMocks.serverWebUiApi.mockResolvedValue({ items: [] });
  return OverviewPage({ searchParams: Promise.resolve({ tag }) });
}

function requestedBody() {
  const init = apiMocks.serverApiV1.mock.calls[0]?.[1] as
    | RequestInit
    | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("overview search routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
  });

  it.each(["AI", "城市夜景航拍", "海边 小船 夕阳"])(
    "routes label query %s through paginated hybrid recall",
    async (tag) => {
      await renderSearch(tag);

      expect(requestedBody()).toMatchObject({ keywords: [tag] });
      expect(requestedBody()).not.toHaveProperty("query");
    },
  );

  it.each([
    "夕阳下一个人在山间行走",
    "帮我找一段适合产品发布的视频",
    "a woman walking on the beach",
  ])("routes sentence query %s through paginated hybrid recall", async (tag) => {
    await renderSearch(tag);

    expect(requestedBody()).toMatchObject({ keywords: [tag] });
    expect(requestedBody()).not.toHaveProperty("query");
  });

  it("renders the API explanation when all candidates are below threshold", async () => {
    const message = "找到候选素材，但最高匹配分为 0.610，未超过展示阈值 0.750。";
    const view = await renderSearch(
      "AI",
      emptyPage({
        mode: "hybrid",
        threshold: 0.75,
        max_score: 0.61,
        reason: "below_threshold",
        message,
      }),
    );

    const text = renderedText(view);
    expect(text).toContain(message);
    expect(text.replace(/\s+/g, "")).toContain("最高排序分0.610");
  });

  it("shows the pending review view for a private library", async () => {
    apiMocks.serverApiV1.mockResolvedValue(emptyPage());
    apiMocks.serverWebUiApi.mockResolvedValue({ items: [] });

    const view = await OverviewPage({
      searchParams: Promise.resolve({
        scope: "private",
        user_id: "user-7",
        view: "pending",
      }),
    });

    expect(requestedBody()).toMatchObject({
      filter: {
        user_scope: { mode: "user", user_id: "user-7" },
        review_statuses: ["pending_review"],
      },
    });
    expect(renderedText(view)).toContain("待入库");
  });

  it("drops the personal user when switching to public and ignores stale public URL user IDs", async () => {
    apiMocks.serverApiV1.mockResolvedValue(emptyPage());
    apiMocks.serverWebUiApi.mockResolvedValue({ items: [] });
    const view = await OverviewPage({
      searchParams: Promise.resolve({ scope: "private", user_id: "user-7", tag: "海边" }),
    });
    const switcher = React.Children.toArray(view.props.children).find(
      (child) => React.isValidElement(child) && child.type === AssetScopeSwitcher,
    );
    if (!React.isValidElement<{ publicHref: string }>(switcher)) throw new Error("Missing scope switcher");
    const target = new URL(switcher.props.publicHref, "http://localhost");
    expect(target.searchParams.get("scope")).toBe("public");
    expect(target.searchParams.get("tag")).toBe("海边");
    expect(target.searchParams.has("user_id")).toBe(false);

    apiMocks.serverApiV1.mockClear();
    await OverviewPage({
      searchParams: Promise.resolve({ scope: "public", user_id: "user-7", tag: "海边" }),
    });
    expect(requestedBody()).toMatchObject({
      keywords: ["海边"],
      filter: { user_scope: { mode: "public" } },
    });
    expect((requestedBody().filter as { user_scope: object }).user_scope).not.toHaveProperty("user_id");
  });

  it("keeps the page, filter and private scope in detail return links", async () => {
    apiMocks.serverApiV1.mockResolvedValue({ ...emptyPage(), items: [{ asset_id: "asset-a" }] });
    apiMocks.serverWebUiApi.mockResolvedValue({ items: [] });
    const parameters = { scope: "private", user_id: "user-7", tag: "夕阳", layout: "list", cursor: "page-3",
      history: Buffer.from(JSON.stringify([null, "page-2"])).toString("base64url") };
    const view = await OverviewPage({ searchParams: Promise.resolve(parameters) });
    const grid = React.Children.toArray(view.props.children).find(child => React.isValidElement(child) && child.type === AssetOverviewGrid);
    if (!React.isValidElement<{ returnTo: string }>(grid)) throw new Error("Missing grid");
    const target = new URL(grid.props.returnTo, "http://localhost");
    for (const [key, value] of Object.entries(parameters)) expect(target.searchParams.get(key)).toBe(value);
    expect(renderedText(view).replace(/\s+/g, "")).toContain("第3页");
  });

  it.each([16, 8, 0])("returns to the last available page when deletion leaves %s assets", async total => {
    apiMocks.serverApiV1.mockResolvedValue({ ...emptyPage(), tag_statistics: { total_assets: total } });
    apiMocks.serverWebUiApi.mockResolvedValue({ items: [] });
    const action = OverviewPage({ searchParams: Promise.resolve({ scope: "private", user_id: "user-7", tag: "夕阳", layout: "list",
      cursor: "page-3", history: Buffer.from(JSON.stringify([null, "page-2"])).toString("base64url") }) });
    const error = await action.catch(cause => cause);
    expect(error.digest).toContain("NEXT_REDIRECT");
    const target = new URL(error.digest.split(";")[2], "http://localhost");
    expect(target.searchParams.get("cursor")).toBe(total === 16 ? "page-2" : null);
    expect(target.searchParams.get("scope")).toBe("private");
    expect(target.searchParams.get("user_id")).toBe("user-7");
    expect(target.searchParams.get("tag")).toBe("夕阳");
    expect(target.searchParams.get("layout")).toBe("list");
  });

  it.each([appUrl("/?cursor=page-3&scope=private&user_id=user-7"), "https://evil.example/", "//evil.example/", "javascript:alert(1)", "/upload"])(
    "only accepts overview return URLs: %s", async returnTo => {
      apiMocks.serverApiV1.mockResolvedValue({ user_id: "user-7", review_status: "pending_review" });
      const view = await AssetDetailPage({ params: Promise.resolve({ id: "asset-a" }), searchParams: Promise.resolve({ return_to: returnTo }) });
      const target = view.props.children.props.returnTo;
      expect(target).toBe(returnTo.startsWith(appUrl("/?")) ? returnTo : appUrl("/?view=pending&scope=private&user_id=user-7"));
    },
  );
});
