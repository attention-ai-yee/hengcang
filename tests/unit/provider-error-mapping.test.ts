import { describe, expect, it } from "vitest";
import { HttpError, httpFailure } from "@/providers/shared";

/**
 * 回归测试（Code Review M2）：非 2xx 时结构化错误码必须可达。
 * FRED 的 400（api_key 无效）→ PERMISSION_DENIED，429 → RATE_LIMITED，
 * 不再一律 UPSTREAM_ERROR 导致消费端分支永假。
 */
function codeOf(error: HttpError): string {
  const result = httpFailure("test", error);
  if (result.ok) throw new Error("expected failure");
  return result.error.code;
}

describe("HTTP 状态码 → 结构化错误码映射（M2）", () => {
  it("FRED 400 + api_key 错误体 → PERMISSION_DENIED", () => {
    expect(codeOf(new HttpError(400, { error_code: 400, error_message: "api_key: Invalid API key" }))).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("401/403 → PERMISSION_DENIED", () => {
    expect(codeOf(new HttpError(401, null))).toBe("PERMISSION_DENIED");
    expect(codeOf(new HttpError(403, "forbidden"))).toBe("PERMISSION_DENIED");
  });

  it("429 → RATE_LIMITED", () => {
    expect(codeOf(new HttpError(429, { message: "rate limit exceeded" }))).toBe("RATE_LIMITED");
  });

  it("其余 5xx/400 → UPSTREAM_ERROR，错误体信息被保留", () => {
    expect(codeOf(new HttpError(500, { message: "internal error" }))).toBe("UPSTREAM_ERROR");
    const result = httpFailure("test", new HttpError(400, { error_message: "parameter error" }));
    if (result.ok) throw new Error("expected failure");
    expect(result.error.message).toContain("parameter error");
    expect(result.error.message).toContain("400");
  });
});
