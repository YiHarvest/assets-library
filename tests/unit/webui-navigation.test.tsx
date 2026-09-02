import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WebUiLink } from "@/components/webui-link";

describe("WebUI rewrite-safe navigation", () => {
  it("renders a native document navigation link with the public prefix intact", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(
      <WebUiLink href="/feisu/assets-library/upload">上传素材</WebUiLink>,
    );

    expect(html).toContain('href="/feisu/assets-library/upload"');
    expect(html).toContain('data-webui-navigation="document"');
  });
});
