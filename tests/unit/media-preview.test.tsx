import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaPreview } from "@/components/media-preview";

describe("MediaPreview", () => {
  it("视频先展示持久化首帧，且在播放前不预加载视频本体", () => {
    const html = renderToStaticMarkup(
      <MediaPreview
        mediaType="video"
        src="/api/v1/media?asset_id=video-id"
        poster="/api/v1/thumbnail?asset_id=video-id"
        name="测试视频"
      />,
    );

    expect(html).toContain('poster="/api/v1/thumbnail?asset_id=video-id"');
    expect(html).toContain('src="/api/v1/media?asset_id=video-id"');
    expect(html).toContain('preload="none"');
  });
});
