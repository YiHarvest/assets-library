import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson, withApiV1 } from "@/server/api/handler";
import {
  auditLog,
  errorAuditFields,
  runWithAuditContext,
  safeUrl,
  responseBodyAudit,
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

  it("keeps each concurrent request's input, repeated query values and streamed output together", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await Promise.all(["one", "two"].map(async (name) => {
      const request = new Request("http://localhost/api/v1/assets/query?tag=a&tag=b&token=hidden", {
        method: "POST",
        body: JSON.stringify({ name, password: "hidden" }),
      });
      const response = await withApiV1(request, async () => {
        const input = await parseJson(request, z.object({ name: z.string() }));
        return Response.json({ items: [{ name: input.name, nested: { token: "hidden", value: "visible" } }] });
      });
      expect(await response.json()).toMatchObject({ items: [{ name, nested: { token: "hidden" } }] });
    }));
    const logs = info.mock.calls.map(([line]) => JSON.parse(String(line)));
    const completed = logs.filter((log) => log.event === "api_request_completed");
    expect(completed).toHaveLength(2);
    for (const log of completed) {
      expect(log.query).toEqual({ tag: ["a", "b"], token: "[redacted]" });
      expect(log.input.password).toBe("[redacted]");
      expect(log.output.items).toEqual([{ name: log.input.name, nested: { token: "[redacted]", value: "visible" } }]);
      expect(log.http_status).toBe(200);
      expect(log.response_bytes).toBeGreaterThan(0);
      expect(log.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(completed.map((log) => log.request_id)).size).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("hidden");
  });

  it("logs the original invalid input and the exact API error response", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("http://localhost/api/v1/assets/query", {
      method: "POST", body: JSON.stringify({ count: "bad", key: "hidden" }),
    });
    const response = await withApiV1(request, async () => {
      await parseJson(request, z.object({ count: z.number() }));
      return Response.json({ ok: true });
    });
    expect(response.status).toBe(400);
    const log = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(log.input).toEqual({ count: "bad", key: "[redacted]" });
    expect(log.output).toEqual(await response.json());
  });

  it("captures chunked MCP SSE and redacts embedded JSON text", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const capture = responseBodyAudit(new Response("", { headers: { "content-type": "text/event-stream" } }));
    const payload = { result: { content: [{ type: "text", text: JSON.stringify({ name: "中文", token: "hidden" }) }] } };
    const bytes = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const byte of bytes) capture.write(Uint8Array.of(byte));
    runWithAuditContext({ requestId: "test", channel: "mcp", operation: "test", fields: { input: { key: "hidden" } } }, () => {
      auditLog("mcp_request_completed", capture.fields());
    });
    const log = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(log.output[0].result.content[0].text).toEqual({ name: "中文", token: "[redacted]" });
    expect(JSON.stringify(log)).not.toContain("hidden");
  });

  it("bounds capture memory and leaves binary streams, cancellation and empty responses intact", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("http://localhost/api/v1/media/test");
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
      cancel: cancelled,
    });
    const response = await withApiV1(request, () => new Response(stream, { headers: { "content-type": "video/mp4" } }));
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1, 2, 3));
    await reader.cancel();
    expect(cancelled).toHaveBeenCalledOnce();

    const binary = responseBodyAudit(new Response("", { headers: { "content-type": "video/mp4" } }));
    binary.write(Uint8Array.of(1, 2, 3));
    expect(binary.fields()).toMatchObject({ output: { omitted: "binary_body" }, response_bytes: 3 });
    const large = responseBodyAudit(Response.json({}));
    large.write(new Uint8Array(65537));
    expect(large.fields()).toMatchObject({ output: { omitted: "body_too_large" }, response_bytes: 65537 });

    const empty = await withApiV1(request, () => new Response(null, { status: 204 }));
    expect(empty.body).toBeNull();
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toMatchObject({ output: null, http_status: 204 });
  });
});
