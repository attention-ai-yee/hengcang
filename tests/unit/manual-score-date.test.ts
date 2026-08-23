import { describe, expect, it } from "vitest";
import { manualScorePayloadSchema } from "@/lib/validation";

/**
 * 回归测试（Code Review M9）：手工评分的 asOf 不允许是未来日期——
 * 未来快照会永久占据榜单首位并参与确认链。
 */
describe("手工评分日期校验（M9）", () => {
  it("未来日期被拒绝", () => {
    const payload = {
      assetBucket: "GOLD" as const,
      cheapnessScore: 60,
      fundamentalScore: 50,
      trendScore: 40,
      asOf: "2099-01-01",
    };
    expect(manualScorePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("过去或今天的日期通过", () => {
    const payload = {
      assetBucket: "GOLD" as const,
      cheapnessScore: 60,
      fundamentalScore: 50,
      trendScore: 40,
      asOf: "2020-01-01",
    };
    expect(manualScorePayloadSchema.safeParse(payload).success).toBe(true);
  });
});
