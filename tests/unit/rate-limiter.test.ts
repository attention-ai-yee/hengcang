import { describe, expect, it } from "vitest";
import { clampInt } from "@/providers/tushare/rate-limiter";

/** 复查发现：.env.local 里留一行 TUSHARE_MAX_RPM= 会被当成每分钟 1 次，周度财报刷新拖好几个小时。 */
describe("clampInt（Tushare 限流参数）", () => {
  it("留空、空白、非数字、≤ 0 都按默认值", () => {
    for (const raw of [undefined, "", "  ", "abc", "0", "-5", 0]) expect(clampInt(raw, 120, 1, 600)).toBe(120);
  });

  it("合法值取整并钳位", () => {
    expect(clampInt("90", 120, 1, 600)).toBe(90);
    expect(clampInt("2.6", 120, 1, 600)).toBe(3);
    expect(clampInt("10000", 120, 1, 600)).toBe(600);
  });
});
