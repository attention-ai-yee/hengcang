import { describe, expect, it } from "vitest";
import { holdingPatchSchema, holdingPayloadSchema } from "@/lib/validation";

/**
 * 回归测试（Code Review H8）：zod v4 的 .partial() 不清除 ZodDefault，
 * safeParse({}) 会产出全部默认键——空补丁通过校验、单字段修改静默重置布尔标志。
 * 补丁 schema 必须显式 optional 且无 default。
 */
describe("持仓补丁校验（H8）", () => {
  it("空补丁被拒绝", () => {
    expect(holdingPatchSchema.safeParse({}).success).toBe(false);
  });

  it("单字段补丁只包含该字段，不携带任何默认键", () => {
    const parsed = holdingPatchSchema.safeParse({ name: "改名" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["name"]);
    }
  });

  it("显式提供的布尔标志正常更新", () => {
    const parsed = holdingPatchSchema.safeParse({ needsBreakdown: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["needsBreakdown"]);
      expect(parsed.data.needsBreakdown).toBe(true);
    }
  });

  it("非法字段值仍被拒绝", () => {
    expect(holdingPatchSchema.safeParse({ marketValueMinor: "-5" }).success).toBe(false);
    expect(holdingPatchSchema.safeParse({ assetBucket: "NOT_A_BUCKET" }).success).toBe(false);
  });

  it("POST 载荷的默认值行为保持不变", () => {
    const parsed = holdingPayloadSchema.safeParse({
      name: "x",
      instrumentType: "FUND",
      assetBucket: "GOLD",
      marketValueMinor: "1",
      asOf: "2026-08-23",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.region).toBe("CN");
      expect(parsed.data.currency).toBe("CNY");
      expect(parsed.data.isSingleStock).toBe(false);
      expect(parsed.data.needsBreakdown).toBe(false);
    }
  });
});
