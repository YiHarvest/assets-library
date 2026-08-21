import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  errorAuditFields,
  runWithAuditContext,
  safeUrl,
} from "@/server/observability/audit-log";

describe("structured audit logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("correlates events and redacts credentials and signed URL queries", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    runWithAuditContext(
      {
        requestId: "00000000-0000-4000-8000-000000000001",
        channel: "mcp",
        operation: "mcp:upload_from_url",
        fields: { user_id: "user-001" },
      },
      () => {
        auditLog("mcp_tool_started", {
          authorization: "Bearer should-not-appear",
          source_url:
            "https://cdn.example.test/video.mp4?signature=should-not-appear",
        });
      },
    );

    const payload = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      event: "mcp_tool_started",
      request_id: "00000000-0000-4000-8000-000000000001",
      channel: "mcp",
      operation: "mcp:upload_from_url",
      user_id: "user-001",
      authorization: "[redacted]",
      source_url: "https://cdn.example.test/video.mp4",
    });
    expect(JSON.stringify(payload)).not.toContain("should-not-appear");
  });

  it("keeps only scheme, host and path for URLs", () => {
    expect(
      safeUrl("https://example.test/a/b.mp4?token=secret#fragment"),
    ).toBe("https://example.test/a/b.mp4");
  });

  it("captures S3-compatible error codes and request IDs", () => {
    const error = Object.assign(new Error("denied"), {
      name: "AccessDenied",
      Code: "AccessDenied",
      $metadata: { httpStatusCode: 403, requestId: "storage-request-1" },
    });
    expect(errorAuditFields(error)).toMatchObject({
      error_type: "AccessDenied",
      error_code: "AccessDenied",
      error_status: 403,
      error_request_id: "storage-request-1",
    });
  });
});
