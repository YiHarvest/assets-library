import { describe, expect, it } from "vitest";
import {
  decodeUserMediaCursor,
  encodeUserMediaCursor,
} from "@/server/modules/users/user-service";

describe("用户媒体 keyset cursor", () => {
  it("往返保留 UTC 毫秒时间和素材 UUID", () => {
    const cursor = {
      createdAt: new Date("2026-08-12T02:17:03.456Z"),
      assetId: "00000000-0000-4000-8000-000000000123",
    };

    expect(decodeUserMediaCursor(encodeUserMediaCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "not-base64-json",
    Buffer.from(JSON.stringify({ page: 2 })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        created_at: "2026-08-12T10:17:03.456+08:00",
        asset_id: "00000000-0000-4000-8000-000000000123",
      }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        created_at: "2026-08-12T02:17:03.456Z",
        asset_id: "not-a-uuid",
      }),
    ).toString("base64url"),
  ])("拒绝损坏、旧格式或非 UTC 游标", (cursor) => {
    expect(() => decodeUserMediaCursor(cursor)).toThrow(
      "cursor 无效或已经过期",
    );
  });
});
