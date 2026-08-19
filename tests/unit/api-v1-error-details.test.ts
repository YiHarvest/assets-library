import { describe, expect, it } from "vitest";
import { apiTaskErrorPayload } from "@/server/modules/tasks/task-service";

describe("API v1 task error details", () => {
  it("maps internal scene errors to the public contract and snake_case details", () => {
    expect(
      apiTaskErrorPayload({
        errorCode: "scene_segment_too_large",
        errorMessage: "一个切片超过限制。",
        errorDetails: {
          segments: [
            {
              segmentIndex: 2,
              filename: "segment-002.mp4",
              actualBytes: 10_485_761,
              maximumBytes: 10_485_760,
            },
          ],
        },
      }),
    ).toEqual({
      code: "segment_too_large",
      message: "一个切片超过限制。",
      details: [
        {
          segment_index: 2,
          filename: "segment-002.mp4",
          size_bytes: 10_485_761,
          limit_bytes: 10_485_760,
        },
      ],
    });
  });

  it("never exposes an unknown internal error code", () => {
    expect(
      apiTaskErrorPayload({
        errorCode: "unexpected_private_code",
        errorMessage: "failed",
        errorDetails: null,
      }),
    ).toEqual({ code: "internal_error", message: "failed" });
  });
});
