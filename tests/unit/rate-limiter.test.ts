import { describe, expect, it } from "vitest";
import { clampInt, TushareRateLimiter } from "@/providers/tushare/rate-limiter";

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

describe("TushareRateLimiter 均匀发请求", () => {
  it("相邻请求至少间隔 60 秒 / 每分钟上限，不先连发再干等（干等时长连接会被关掉，重连换出口 IP）", async () => {
    const limiter = new TushareRateLimiter({ maxRequestsPerMinute: 1200, concurrency: 1 });
    const starts: number[] = [];
    for (let index = 0; index < 5; index += 1) await limiter.run(async () => { starts.push(Date.now()); }, () => false);
    const gaps = starts.slice(1).map((start, index) => start - starts[index]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(45);
  });
});
