import * as React from "react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  serverApiV1: vi.fn(),
  serverWebUiApi: vi.fn(),
}));

vi.mock("@/lib/server-api-v1", () => apiMocks);

import OverviewPage from "@/app/page";

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
    "routes label query %s through keyword recall",
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
  ])("routes sentence query %s through semantic recall", async (tag) => {
    await renderSearch(tag);

    expect(requestedBody()).toMatchObject({ query: tag });
    expect(requestedBody()).not.toHaveProperty("keywords");
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
    expect(text.replace(/\s+/g, "")).toContain("最高相关度61%");
  });
});
