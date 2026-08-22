import type { MetricSeries, PointMetric, TrendModelInput } from "@/domain/scoring";

function derivedSeries(
  input: MetricSeries,
  name: string,
  calculate: (values: number[], index: number) => number | null,
): MetricSeries {
  const sorted = [...input.history].sort((first, second) => first.asOf.localeCompare(second.asOf));
  const values = sorted.map((point) => point.value);
  const history = sorted.flatMap((point, index) => {
    const value = calculate(values, index);
    return value === null || !Number.isFinite(value)
      ? []
      : [{ value, asOf: point.asOf, availableAt: point.availableAt }];
  });
  const latest = history.at(-1);
  return {
    currentValue: latest?.value ?? null,
    history,
    source: `DERIVED:${name}:${input.source}`,
    asOf: latest?.asOf ?? input.asOf,
    availableAt: latest?.availableAt,
  };
}

function movingAverage(input: MetricSeries, window: number): MetricSeries {
  return derivedSeries(input, `MA${window}`, (values, index) => {
    if (index + 1 < window) return null;
    const sample = values.slice(index + 1 - window, index + 1);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  });
}

function momentum(input: MetricSeries, tradingDays: number, label: string): MetricSeries {
  return derivedSeries(input, label, (values, index) => {
    if (index < tradingDays || values[index - tradingDays] === 0) return null;
    return values[index] / values[index - tradingDays] - 1;
  });
}

function distanceFromMovingAverage(price: MetricSeries, average: MetricSeries): MetricSeries {
  const averageByDate = new Map(average.history.map((point) => [point.asOf, point]));
  const history = price.history.flatMap((point) => {
    const ma = averageByDate.get(point.asOf);
    if (!ma || ma.value === 0) return [];
    return [{ value: point.value / ma.value - 1, asOf: point.asOf, availableAt: point.availableAt }];
  });
  const latest = history.at(-1);
  return {
    currentValue: latest?.value ?? null,
    history,
    source: `DERIVED:DISTANCE_MA200:${price.source}`,
    asOf: latest?.asOf ?? price.asOf,
    availableAt: latest?.availableAt,
  };
}

function point(series: MetricSeries): PointMetric {
  return {
    value: series.currentValue,
    source: series.source,
    asOf: series.asOf,
    confidence: series.source === "UNAVAILABLE" ? "LOW" : undefined,
  };
}

export interface PriceFeatures {
  pricePosition: MetricSeries;
  distanceFromMa200: MetricSeries;
  momentum3m: MetricSeries;
  trend: TrendModelInput;
}

export function derivePriceFeatures(close: MetricSeries): PriceFeatures {
  const ma20 = movingAverage(close, 20);
  const ma60 = movingAverage(close, 60);
  const ma200 = movingAverage(close, 200);
  const momentum3m = momentum(close, 63, "MOMENTUM_3M");
  const momentum6m = momentum(close, 126, "MOMENTUM_6M");
  return {
    pricePosition: close,
    distanceFromMa200: distanceFromMovingAverage(close, ma200),
    momentum3m,
    trend: {
      price: point(close),
      ma20: point(ma20),
      ma60: point(ma60),
      ma200: point(ma200),
      momentum6m,
    },
  };
}
