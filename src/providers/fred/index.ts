import { fetchJson, HttpError, httpFailure, providerFailure } from "../shared";
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

interface FredResponse {
  observations?: Array<{ date: string; value: string; realtime_start: string }>;
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const FRED_SERIES_MAP = {
  REAL_YIELD_10Y: "DFII10",
  DOLLAR_INDEX: "DTWEXBGS",
} as const;

/**
 * 各序列官方文档化发布时点对应的北京时间偏移（评审复查 M12：
 * 原一刀切「次日 18:00」不是真实元数据；改为引用来源的保守滞后）。
 * - DFII10：美国财政部日度票息收益率曲线约 15:30 ET 发布、FRED 当晚入库
 *   （home.treasury.gov，Daily Treasury Par Yield Curve Rates）。
 *   取北京时间次日 12:00：冬令时 15:30 ET = 次日 04:30 北京，余量 7 小时。
 * - DTWEXBGS：美联储 H.10 午间美元汇率约 12:00 ET 发布
 *   （federalreserve.gov/releases/h10）。
 *   取北京时间次日 06:00：冬令时 12:00 ET = 次日 01:00 北京，余量 5 小时。
 * 未映射序列退回次日 18:00（原保守值）。夏令时切换只影响 1 小时，被余量覆盖。
 */
const FRED_AVAILABLE_AT_OFFSET: Record<string, string> = {
  DFII10: "T12:00:00+08:00",
  DTWEXBGS: "T06:00:00+08:00",
};

export class FredProvider implements MarketDataProvider {
  readonly id = "fred";

  constructor(private readonly apiKey = process.env.FRED_API_KEY) {}

  capabilities(): ProviderCapability[] {
    return ["MACRO_SERIES"];
  }

  async getMacroSeries(request: MacroRequest): Promise<ProviderResult<MetricPoint[]>> {
    if (!this.apiKey) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 FRED_API_KEY");
    const url = new URL("https://api.stlouisfed.org/fred/series/observations");
    const seriesId = FRED_SERIES_MAP[request.seriesId as keyof typeof FRED_SERIES_MAP];
    if (!seriesId) return providerFailure(this.id, "NOT_SUPPORTED", `未映射 FRED 宏观序列 ${request.seriesId}`);
    url.searchParams.set("series_id", seriesId);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("observation_start", request.range.start);
    url.searchParams.set("observation_end", request.range.end);
    try {
      const response = await fetchJson<FredResponse>(url.toString());
      const data = (response.observations ?? [])
        .filter((observation) => observation.value !== ".")
        .map((observation): MetricPoint => ({
          key: request.seriesId,
          value: observation.value,
          unit: request.seriesId === "REAL_YIELD_10Y" ? "percent" : "index",
          observedAt: `${observation.date}T00:00:00Z`,
          // 无前视（Code Review M12）：按各序列官方文档化发布时点取保守 availableAt；
          // 不使用 realtime_start（未请求 vintage 时恒等于观察日）。见 FRED_AVAILABLE_AT_OFFSET。
          availableAt: `${nextDay(observation.date)}${FRED_AVAILABLE_AT_OFFSET[seriesId] ?? "T18:00:00+08:00"}`,
          asOf: observation.date,
        }));
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      if (error instanceof HttpError) return httpFailure(this.id, error);
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "FRED 请求失败");
    }
  }

  async getPriceSeries(_request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责市场行情");
  }

  async getValuationMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责估值数据");
  }

  async getFundamentalMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责财务数据");
  }
}
