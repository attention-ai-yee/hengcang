import { describe, expect, it } from "vitest";
import { shanghaiDate } from "@/lib/shanghai";
import { manualScorePayloadSchema } from "@/lib/validation";

/**
 * 回归测试（Code Review M9 加严）：手工评分只允许记录「上海时区今天」。
 * 过去日期会以 (portfolio,bucket,asOf) upsert 覆盖同日自动快照，并把
 * candidateState 写进候选链，污染 3 日确认与回测状态；未来日期则会永久占据榜首。
 */
function payloadWith(asOf: string) {
  return {
    assetBucket: "GOLD" as const,
    cheapnessScore: 60,
    fundamentalScore: 50,
    trendScore: 40,
    asOf,
  };
}

describe("手工评分日期校验（M9）", () => {
  it("未来日期被拒绝", () => {
    expect(manualScorePayloadSchema.safeParse(payloadWith("2099-01-01")).success).toBe(false);
  });

  it("过去日期被拒绝（只允许当天，避免覆盖历史自动快照）", () => {
    const result = manualScorePayloadSchema.safeParse(payloadWith("2020-01-01"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("")).toContain("手工评分只允许记录当天");
    }
  });

  it("上海时区今天通过", () => {
    expect(manualScorePayloadSchema.safeParse(payloadWith(shanghaiDate())).success).toBe(true);
  });
});
