import { fetchJson, providerFailure } from "../shared";
import { TushareRateLimiter } from "./rate-limiter";
import type { DailyBasicRow, EquityFundamentalSnapshot, IndexWeightPoint } from "./index-aggregator";
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

export interface TushareDividendRecord {
  symbol: string;
  announcementDate: string;
  reportPeriod: string;
  procedure: string | null;
  cashDividend: number | null;
  recordDate: string | null;
  exDate: string | null;
  payDate: string | null;
}

export interface FundSharePoint { symbol: string; tradeDate: string; shares: number; }
export interface FundNavPoint { symbol: string; navDate: string; availableAt: string; unitNav: number; }

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
  private readonly limiter = new TushareRateLimiter();

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
    return providerFailure(this.id, "NOT_SUPPORTED", `v1.1 宏观序列 ${request.seriesId} 必须由 FRED 提供`);
  }

  async getIndexWeights(indexSymbol: string, range: { start: string; end: string }): Promise<ProviderResult<IndexWeightPoint[]>> {
    return this.rows("index_weight", { index_code: indexSymbol, start_date: compactDate(range.start), end_date: compactDate(range.end) }, "index_code,con_code,trade_date,weight", (row) => {
      if (!isValue(row.weight)) return [];
      const effectiveDate = dayFromTushare(row.trade_date);
      const constituentSymbol = String(row.con_code ?? "");
      return effectiveDate.length === 10 && constituentSymbol ? [{
        indexSymbol: String(row.index_code ?? indexSymbol), constituentSymbol, effectiveDate, weight: Number(row.weight) / 100,
      }] : [];
    });
  }

  async getMarketDailyBasics(tradeDate: string): Promise<ProviderResult<DailyBasicRow[]>> {
    return this.rows("daily_basic", { trade_date: compactDate(tradeDate) }, "ts_code,trade_date,pe_ttm,pb,ps_ttm,dv_ttm,total_mv", (row) => {
      const symbol = String(row.ts_code ?? "");
      if (!symbol) return [];
      return [{
        symbol, tradeDate: dayFromTushare(row.trade_date), peTtm: numericOrNull(row.pe_ttm), pb: numericOrNull(row.pb),
        psTtm: numericOrNull(row.ps_ttm), dividendYield: numericOrNull(row.dv_ttm),
      }];
    });
  }

  async getEquityFundamentals(symbol: string, range: { start: string; end: string }): Promise<ProviderResult<EquityFundamentalSnapshot[]>> {
    return this.rows("fina_indicator", { ts_code: symbol, start_date: compactDate(range.start), end_date: compactDate(range.end) }, "ts_code,ann_date,end_date,roe,netprofit_yoy,tr_yoy,or_yoy,q_sales_yoy,update_flag", (row) => {
      const reportPeriod = dayFromTushare(row.end_date);
      const announced = dayFromTushare(row.ann_date ?? row.end_date);
      if (reportPeriod.length !== 10 || announced.length !== 10) return [];
      return [{
        symbol: String(row.ts_code ?? symbol), reportPeriod, availableAt: `${announced}T08:00:00+08:00`, roe: numericOrNull(row.roe),
        earningsGrowth: numericOrNull(row.netprofit_yoy), revenueGrowth: numericOrNull(row.tr_yoy),
      }];
    });
  }

  async getEquityDividendHistory(symbol: string): Promise<ProviderResult<TushareDividendRecord[]>> {
    return this.rows("dividend", { ts_code: symbol }, "ts_code,ann_date,end_date,div_proc,cash_div_tax,record_date,ex_date,pay_date", (row) => [{
      symbol: String(row.ts_code ?? symbol), announcementDate: dayFromTushare(row.ann_date), reportPeriod: dayFromTushare(row.end_date),
      procedure: row.div_proc === null ? null : String(row.div_proc), cashDividend: numericOrNull(row.cash_div_tax),
      recordDate: isValue(row.record_date) ? dayFromTushare(row.record_date) : null, exDate: isValue(row.ex_date) ? dayFromTushare(row.ex_date) : null,
      payDate: isValue(row.pay_date) ? dayFromTushare(row.pay_date) : null,
    }]);
  }

  async getFundShare(symbol: string, range: { start: string; end: string }): Promise<ProviderResult<FundSharePoint[]>> {
    return this.rows("fund_share", { ts_code: symbol, start_date: compactDate(range.start), end_date: compactDate(range.end) }, "ts_code,trade_date,fd_share", (row) => {
      const shares = numericOrNull(row.fd_share);
      return shares === null ? [] : [{ symbol: String(row.ts_code ?? symbol), tradeDate: dayFromTushare(row.trade_date), shares }];
    });
  }

  async getFundNavForFlow(symbol: string, range: { start: string; end: string }): Promise<ProviderResult<FundNavPoint[]>> {
    return this.rows("fund_nav", { ts_code: symbol, start_date: compactDate(range.start), end_date: compactDate(range.end) }, "ts_code,ann_date,nav_date,unit_nav", (row) => {
      const unitNav = numericOrNull(row.unit_nav);
      const navDate = dayFromTushare(row.nav_date);
      if (unitNav === null || navDate.length !== 10) return [];
      const announced = dayFromTushare(row.ann_date ?? row.nav_date);
      return [{ symbol: String(row.ts_code ?? symbol), navDate, availableAt: `${announced}T18:00:00+08:00`, unitNav }];
    });
  }

  private async rows<T>(apiName: string, params: Record<string, string>, fields: string, map: (row: TushareRow) => T[]): Promise<ProviderResult<T[]>> {
    if (!this.token) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TUSHARE_TOKEN");
    try {
      const response = await this.query(apiName, params, fields);
      if (response.code !== 0 || !response.data) return providerFailure(this.id, failureCode(response), response.msg ?? "Tushare 返回错误");
      return { ok: true, data: rowsOf(response).flatMap(map), provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Tushare 请求失败");
    }
  }

  private query(apiName: string, params: Record<string, string>, fields: string) {
    return this.limiter.run(() => fetchJson<TushareResponse>("https://api.tushare.pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_name: apiName, token: this.token, params, fields }),
    }), () => true);
  }
}

function compactDate(value: string) { return value.replaceAll("-", ""); }
function numericOrNull(value: unknown) { return isValue(value) ? Number(value) : null; }
