import { describe, expect, it } from "vitest";
import { previewManualObservationImport } from "@/metrics/manual-import";

describe("Manual CSV / JSON 导入预览", () => {
  it("解析 CSV、补齐时间和默认单位", () => {
    const csv = [
      "subject_type,subject_id,metric_key,value,unit,as_of,available_at,observed_at",
      "ASSET_BUCKET,GOLD,REAL_YIELD_10Y,1.75,percent,2026-08-20,,",
    ].join("\n");
    const preview = previewManualObservationImport("csv", csv);

    expect(preview.errors).toEqual([]);
    expect(preview.validRows).toBe(1);
    expect(preview.rows[0]).toMatchObject({
      subjectId: "GOLD",
      metricKey: "REAL_YIELD_10Y",
      asOf: "2026-08-20",
      availableAt: "2026-08-20T23:59:59Z",
    });
  });

  it("JSON 支持 rows 包装并拒绝超出范围的评分指标", () => {
    const preview = previewManualObservationImport("json", JSON.stringify({ rows: [{
      subjectId: "GOLD",
      metricKey: "CENTRAL_BANK_DEMAND_SCORE",
      value: 120,
      asOf: "2026-08-20",
    }] }));
    expect(preview.errors[0]).toMatchObject({ field: "value", message: "评分型指标必须位于 0–100" });
  });

  it("相同记录去重，冲突记录阻止提交", () => {
    const base = { subjectId: "BROAD_EQUITY", metricKey: "PE_TTM", value: 12, asOf: "2026-08-20" };
    const duplicate = previewManualObservationImport("json", JSON.stringify([base, base]));
    expect(duplicate.validRows).toBe(1);
    expect(duplicate.duplicateRows).toBe(1);
    expect(duplicate.errors).toEqual([]);

    const conflict = previewManualObservationImport("json", JSON.stringify([base, { ...base, value: 13 }]));
    expect(conflict.errors[0].message).toContain("冲突值");
  });

  it("价格、估值倍数必须大于 0，股息率不能为负（手工值永远优先，写错会长期污染评分）", () => {
    const rows = [
      { subjectId: "BROAD_EQUITY", metricKey: "PRICE_CLOSE", value: -5, asOf: "2026-08-20" },
      { subjectId: "BROAD_EQUITY", metricKey: "PE_TTM", value: 0, asOf: "2026-08-20" },
      { subjectId: "VALUE_DIVIDEND", metricKey: "DIVIDEND_YIELD", value: -1, asOf: "2026-08-20" },
      { subjectId: "VALUE_DIVIDEND", metricKey: "DIVIDEND_YIELD", value: 0, asOf: "2026-08-21" },
      { subjectId: "TECH_GROWTH", metricKey: "EARNINGS_GROWTH", value: -12, asOf: "2026-08-20" },
    ];
    const preview = previewManualObservationImport("json", JSON.stringify(rows));
    expect(preview.errors.map((error) => [error.row, error.message])).toEqual([
      [2, "收盘价必须大于 0"],
      [3, "滚动市盈率必须大于 0"],
      [4, "股息率不能为负数"],
    ]);
  });
});
