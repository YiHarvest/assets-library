import { describe, expect, it } from "vitest";
import { dominantFailure } from "@/server/services/task-lifecycle";

describe("dominantFailure 错误码聚合", () => {
  it("选择出现次数最多的错误码作为代表，并保留去重后的完整集合", () => {
    const result = dominantFailure([
      { code: "model_response_invalid", message: "模型返回内容无法验证" },
      { code: "model_response_invalid", message: "模型返回内容无法验证" },
      { code: "storage_error", message: "存储失败" },
    ]);
    expect(result.code).toBe("model_response_invalid");
    expect(result.message).toBe("模型返回内容无法验证");
    expect(result.codes).toEqual(["model_response_invalid", "storage_error"]);
  });

  it("空输入回退到 internal_error", () => {
    expect(dominantFailure([])).toEqual({
      code: "internal_error",
      message: null,
      codes: [],
    });
  });

  it("缺失错误码时回退并携带首个可用 message", () => {
    const result = dominantFailure([
      { code: null, message: null },
      { code: null, message: "未知错误" },
    ]);
    expect(result.code).toBe("internal_error");
    expect(result.message).toBe("未知错误");
    expect(result.codes).toEqual(["internal_error"]);
  });
});
