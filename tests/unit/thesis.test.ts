import { describe, expect, it } from "vitest";
import { needsThesis, planBreakerChanges, reviewDue, thesisAttention, thesisBlocksAdd, thesisStatus } from "@/domain/thesis";

/** 持仓级投资逻辑与失效条件（docs/hengcang_v2_allocation_fundamentals_thesis.md §4）。 */
describe("thesisStatus", () => {
  it("没写逻辑 / 完好 / 有条件被触发", () => {
    expect(thesisStatus({ hasThesis: false, breakers: [] })).toBe("NO_THESIS");
    expect(thesisStatus({ hasThesis: true, breakers: [{ status: "ACTIVE" }] })).toBe("INTACT");
    expect(thesisStatus({ hasThesis: true, breakers: [{ status: "ACTIVE" }, { status: "TRIGGERED" }] })).toBe("BREACHED");
  });

  it("只有触发未复核才拦住新增", () => {
    expect(thesisBlocksAdd("BREACHED")).toBe(true);
    expect(thesisBlocksAdd("INTACT")).toBe(false);
    expect(thesisBlocksAdd("NO_THESIS")).toBe(false);
  });
});

describe("needsThesis", () => {
  it("单一个股和主题 ETF 必须写投资逻辑，分散资产不强制", () => {
    expect(needsThesis({ isSingleStock: true, isThematicEtf: false })).toBe(true);
    expect(needsThesis({ isSingleStock: false, isThematicEtf: true })).toBe(true);
    expect(needsThesis({ isSingleStock: false, isThematicEtf: false })).toBe(false);
  });
});

describe("reviewDue", () => {
  it("自上次复核（没有则自写下逻辑起）满 90 天到期", () => {
    expect(reviewDue({ lastReviewOn: null, thesisCreatedAt: "2026-07-20T02:00:00.000Z", today: "2026-10-17" })).toBe(false);
    expect(reviewDue({ lastReviewOn: null, thesisCreatedAt: "2026-07-20T02:00:00.000Z", today: "2026-10-18" })).toBe(true);
    expect(reviewDue({ lastReviewOn: "2026-10-01", thesisCreatedAt: "2026-01-01T00:00:00.000Z", today: "2026-10-18" })).toBe(false);
  });
});

describe("planBreakerChanges", () => {
  const existing = [
    { id: "a", description: "行业资本开支同比下滑超过 30%", status: "ACTIVE" },
    { id: "b", description: "最大客户订单明显缩减", status: "TRIGGERED" },
  ];

  it("新增、修改、删除未触发的条件", () => {
    const plan = planBreakerChanges(existing, [
      { id: "a", description: "行业资本开支同比下滑超过 25%" },
      { id: "b", description: "最大客户订单明显缩减" },
      { description: "毛利率连续两个季度下滑" },
    ]);
    expect(plan).toEqual({ ok: true, update: [{ id: "a", description: "行业资本开支同比下滑超过 25%" }], insert: ["毛利率连续两个季度下滑"], remove: [] });
    expect(planBreakerChanges(existing.slice(0, 1), [])).toEqual({ ok: true, update: [], insert: [], remove: ["a"] });
  });

  it("已触发的条件不能删除，也不能改写（否则不写复核就能绕过暂停）", () => {
    expect(planBreakerChanges(existing, [{ id: "a", description: existing[0].description }])).toEqual({ ok: false, error: "BREAKER_TRIGGERED", breakerId: "b" });
    expect(planBreakerChanges(existing, [{ id: "a", description: existing[0].description }, { id: "b", description: "改个说法" }]))
      .toEqual({ ok: false, error: "BREAKER_TRIGGERED", breakerId: "b" });
  });

  it("提交了不属于这份逻辑的 id 被拒绝", () => {
    expect(planBreakerChanges(existing, [{ id: "zzz", description: "x" }])).toEqual({ ok: false, error: "UNKNOWN_BREAKER", breakerId: "zzz" });
  });
});

describe("thesisAttention", () => {
  const stock = { isSingleStock: true, isThematicEtf: false };
  const fund = { isSingleStock: false, isThematicEtf: false };

  it("触发在前、复核到期其次、集中持仓没写逻辑最后；分散资产和完好的不提醒", () => {
    const holdings = [
      { id: "1", name: "没写逻辑的个股", ...stock },
      { id: "2", name: "沪深300ETF", ...fund },
      { id: "3", name: "复核到期", ...stock },
      { id: "4", name: "完好", ...stock },
      { id: "5", name: "已触发", ...stock },
    ];
    const summaries = new Map([
      ["3", { status: "INTACT" as const, reviewDue: true, triggered: [] }],
      ["4", { status: "INTACT" as const, reviewDue: false, triggered: [] }],
      ["5", { status: "BREACHED" as const, reviewDue: true, triggered: ["最大客户订单明显缩减"] }],
    ]);
    expect(thesisAttention(holdings, summaries)).toEqual([
      { holdingId: "5", name: "已触发", kind: "BREACHED", triggered: ["最大客户订单明显缩减"] },
      { holdingId: "3", name: "复核到期", kind: "REVIEW_DUE", triggered: [] },
      { holdingId: "1", name: "没写逻辑的个股", kind: "MISSING", triggered: [] },
    ]);
  });
});
