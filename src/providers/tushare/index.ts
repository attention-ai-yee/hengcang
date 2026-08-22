import { fetchJson, providerFailure } from "../shared";
import type {
  MacroRequest,
  MarketDataProvider,
  MetricPoint,
  MetricRequest,
  PricePoint,
  PriceSeriesRequest,
  ProviderCapability,
  ProviderResult,
} from "../types";

interface TushareResponse {
  code: number;
  msg: string | null;
  data?: { fields: string[]; items: Array<Array<string | number | null>> };
}

type TushareRow = Record<string, string | number | null>;

function dayFromTushare(value: unknown): string {
  const raw = String(value ?? "");
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function rowsOf(response: TushareResponse): TushareRow[] {
  if (!response.data) return [];
  return response.data.items.map((item) =>
    Object.fromEntries(response.data!.fields.map((field, index) => [field, item[index]])),
  );
}

function isValue(value: unknown): value is string | number {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function failureCode(response: TushareResponse) {
  const message = response.msg?.toLowerCase() ?? "";
  if (response.code === 2002 || message.includes("权限") || message.includes("积分")) return "PERMISSION_DENIED" as const;
  if (message.includes("频次") || message.includes("limit")) return "RATE_LIMITED" as const;
  return "UPSTREAM_ERROR" as const;
}

export class TushareProvider implements MarketDataProvider {
  readonly id = "tushare";

  constructor(private readonly token = process.env.TUSHARE_TOKEN) {}

  capabilities(): ProviderCapability[] {
    return ["PRICE_SERIES", "VALUATION_METRICS", "FUNDAMENTAL_METRICS", "MACRO_SERIES"];
  }

  async getPriceSeries(request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>> {
    if (!this.token) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TUSHARE_TOKEN");
    try {
      const apiName = request.instrumentKind === "INDEX"
        ? "index_daily"
        : request.instrumentKind === "FUND"
          ? "fund_nav"
          : request.instrumentKind === "GOLD_SPOT"
            ? "sge_daily"
            : "daily";
      const dateField = request.instrumentKind === "FUND" ? "nav_date" : "trade_date";
      const response = await this.query(apiName, {
        ts_code: request.symbol,
        start_date: request.range.start.replaceAll("-", ""),
        end_date: request.range.end.replaceAll("-", ""),
      }, request.instrumentKind === "FUND"
        ? "nav_date,ann_date,unit_nav,accum_nav,adj_nav"
        : "trade_date,open,high,low,close,vol");
      if (response.code !== 0 || !response.data) {
        return providerFailure(this.id, failureCode(response), response.msg ?? "Tushare 返回错误");
      }
      const data = rowsOf(response).flatMap((row): PricePoint[] => {
        const day = dayFromTushare(row[dateField]);
        const close = request.instrumentKind === "FUND"
          ? row.adj_nav ?? row.accum_nav ?? row.unit_nav
          : row.close;
        if (!isValue(close) || day.length !== 10) return [];
        const announcedDay = request.instrumentKind === "FUND" && row.ann_date
          ? dayFromTushare(row.ann_date)
          : day;
        return [{
          observedAt: `${day}T15:00:00+08:00`,
          availableAt: `${announcedDay}T18:00:00+08:00`,
          asOf: day,
          open: isValue(row.open) ? String(row.open) : undefined,
          high: isValue(row.high) ? String(row.high) : undefined,
          low: isValue(row.low) ? String(row.low) : undefined,
          close: String(close),
          volume: isValue(row.vol) ? String(row.vol) : undefined,
          currency: "CNY",
        }];
      });
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Tushare 请求失败");
    }
  }

  async getValuationMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    if (!this.token) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TUSHARE_TOKEN");
    if (request.instrumentKind !== "INDEX" && request.instrumentKind !== "EQUITY") {
      return providerFailure(this.id, "NOT_SUPPORTED", "该代理类型没有可用的 Tushare 估值序列");
    }
    try {
      const range = request.range ?? { start: request.asOf ?? "", end: request.asOf ?? "" };
      const response = await this.query(
        request.instrumentKind === "INDEX" ? "index_dailybasic" : "daily_basic",
        {
          ts_code: request.symbol,
          start_date: range.start.replaceAll("-", ""),
          end_date: range.end.replaceAll("-", ""),
        },
        request.instrumentKind === "INDEX"
          ? "trade_date,pe_ttm,pb"
          : "trade_date,pe_ttm,pb,ps_ttm,dv_ttm",
      );
      if (response.code !== 0 || !response.data) {
        return providerFailure(this.id, failureCode(response), response.msg ?? "Tushare 返回错误");
      }
      const fieldMapping: Array<{ field: string; key: string; unit: string }> = [
        { field: "pe_ttm", key: "PE_TTM", unit: "ratio" },
        { field: "pb", key: "PB", unit: "ratio" },
        { field: "ps_ttm", key: "PS", unit: "ratio" },
        { field: "dv_ttm", key: "DIVIDEND_YIELD", unit: "percent" },
      ];
      const data = rowsOf(response).flatMap((row) => {
        const day = dayFromTushare(row.trade_date);
        return fieldMapping.flatMap(({ field, key, unit }): MetricPoint[] => {
          if (!request.metrics.includes(key) || !isValue(row[field])) return [];
          return [{
            key,
            value: String(row[field]),
            unit,
            observedAt: `${day}T15:00:00+08:00`,
            availableAt: `${day}T18:00:00+08:00`,
            asOf: day,
          }];
        });
      });
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Tushare 请求失败");
    }
  }

  async getFundamentalMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    if (!this.token) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TUSHARE_TOKEN");
    if (request.instrumentKind !== "EQUITY") {
      return providerFailure(this.id, "NOT_SUPPORTED", "指数基本面需要成分股聚合，当前刷新不会用单股数据冒充");
    }
    try {
      const range = request.range ?? { start: request.asOf ?? "", end: request.asOf ?? "" };
      const response = await this.query("fina_indicator", {
        ts_code: request.symbol,
        start_date: range.start.replaceAll("-", ""),
        end_date: range.end.replaceAll("-", ""),
      }, "ann_date,end_date,roe,netprofit_yoy,tr_yoy");
      if (response.code !== 0 || !response.data) {
        return providerFailure(this.id, failureCode(response), response.msg ?? "Tushare 返回错误");
      }
      const mapping = [
        { field: "roe", key: "ROE" },
        { field: "netprofit_yoy", key: "EARNINGS_GROWTH" },
        { field: "tr_yoy", key: "REVENUE_GROWTH" },
      ];
      const data = rowsOf(response).flatMap((row) => {
        const asOf = dayFromTushare(row.end_date);
        const announced = dayFromTushare(row.ann_date ?? row.end_date);
        return mapping.flatMap(({ field, key }): MetricPoint[] => {
          if (!request.metrics.includes(key) || !isValue(row[field])) return [];
          return [{
            key,
            value: String(row[field]),
            unit: "percent",
            observedAt: `${asOf}T23:59:59+08:00`,
            availableAt: `${announced}T08:00:00+08:00`,
            asOf,
          }];
        });
      });
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Tushare 请求失败");
    }
  }

  async getMacroSeries(request: MacroRequest): Promise<ProviderResult<MetricPoint[]>> {
    if (!this.token) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TUSHARE_TOKEN");
    if (request.seriesId !== "REAL_YIELD_10Y") {
      return providerFailure(this.id, "NOT_SUPPORTED", `Tushare 暂未映射宏观序列 ${request.seriesId}`);
    }
    try {
      const response = await this.query("us_trycr", {
        start_date: request.range.start.replaceAll("-", ""),
        end_date: request.range.end.replaceAll("-", ""),
      }, "date,y10");
      if (response.code !== 0 || !response.data) {
        return providerFailure(this.id, failureCode(response), response.msg ?? "Tushare 返回错误");
      }
      const data = rowsOf(response).flatMap((row): MetricPoint[] => {
        if (!isValue(row.y10)) return [];
        const day = dayFromTushare(row.date);
        return [{
          key: "REAL_YIELD_10Y",
          value: String(row.y10),
          unit: "percent",
          observedAt: `${day}T00:00:00-05:00`,
          availableAt: `${day}T18:00:00-05:00`,
          asOf: day,
        }];
      });
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Tushare 请求失败");
    }
  }

  private query(apiName: string, params: Record<string, string>, fields: string) {
    return fetchJson<TushareResponse>("https://api.tushare.pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_name: apiName, token: this.token, params, fields }),
    });
  }
}
