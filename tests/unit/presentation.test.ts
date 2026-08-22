import { describe, expect, it } from "vitest";
import { instrumentTypeLabel } from "@/lib/presentation";

describe("instrumentTypeLabel", () => {
  it("把持仓资产类型代码转换成中文", () => {
    expect(instrumentTypeLabel("FUND")).toBe("基金");
    expect(instrumentTypeLabel("ACCOUNT_AGGREGATE")).toBe("账户汇总");
  });

  it("未知类型保留原值，避免空白展示", () => {
    expect(instrumentTypeLabel("CUSTOM_TYPE")).toBe("CUSTOM_TYPE");
  });
});
