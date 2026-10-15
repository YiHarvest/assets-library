import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/db", () => ({ db: {} }));
import { redact, shanghaiIso } from "@/server/services/task-observability";

describe("监控数据脱敏", () => {
  it("保留业务入参并递归移除 token、密码和签名 URL", () => {
    const original = { query: "海边汽车", items: [{ api_key: "secret-value", user_id: "user-7" }], callback_url: "https://alice:pass@example.com/hook?token=private&task_id=123", headers: { authorization: "Bearer sensitive" } };
    const redacted = redact(original);
    expect(JSON.stringify(redacted)).not.toMatch(/secret-value|alice|private|sensitive|:pass/);
    expect(redacted).toMatchObject({ query: "海边汽车", items: [{ user_id: "user-7", api_key: "[REDACTED]" }] });
    expect(original.items[0].api_key).toBe("secret-value");
  });
  it("回调 JSON 文本也脱敏，普通错误可读", () => {
    expect(redact('{"access_token":"secret","count":3}')).toBe('{"access_token":"[REDACTED]","count":3}');
    expect(redact("error: Bearer my-token")).toBe("error: Bearer [REDACTED]");
    expect(redact("Chroma HTTP 503")).toBe("Chroma HTTP 503");
  });
  it("监控时间统一上海时区", () => {
    expect(shanghaiIso(new Date("2026-10-15T00:00:00.000Z"))).toBe("2026-10-15T08:00:00.000+08:00");
    expect(shanghaiIso(null)).toBeNull();
  });
});
