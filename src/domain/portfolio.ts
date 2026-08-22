import { ASSET_BUCKETS, type AssetBucket, type HoldingInput, type PortfolioSummary } from "./types";

function emptyBuckets(): PortfolioSummary["byBucket"] {
  return Object.fromEntries(
    ASSET_BUCKETS.map((bucket) => [bucket, { valueMinor: 0n, investableValueMinor: 0n, weightBps: 0, holdingCount: 0 }]),
  ) as Record<AssetBucket, PortfolioSummary["byBucket"][AssetBucket]>;
}

export function summarizePortfolio(holdings: HoldingInput[], reservedCashMinor = 0n): PortfolioSummary {
  const byBucket = emptyBuckets();
  let totalValueMinor = 0n;

  for (const holding of holdings) {
    if (holding.marketValueMinor < 0n) {
      throw new Error(`持仓市值不能为负数：${holding.name}`);
    }
    totalValueMinor += holding.marketValueMinor;
    byBucket[holding.assetBucket].valueMinor += holding.marketValueMinor;
    byBucket[holding.assetBucket].investableValueMinor += holding.marketValueMinor;
    byBucket[holding.assetBucket].holdingCount += 1;
  }

  if (reservedCashMinor < 0n || reservedCashMinor > totalValueMinor) {
    throw new Error("预留资金必须位于 0 与金融资产总额之间");
  }
  if (reservedCashMinor > byBucket.CASH_BONDS.valueMinor) {
    throw new Error("预留资金不能超过现金与债券桶的当前金额");
  }

  byBucket.CASH_BONDS.investableValueMinor -= reservedCashMinor;
  const investableAssetsMinor = totalValueMinor - reservedCashMinor;

  if (investableAssetsMinor > 0n) {
    for (const bucket of ASSET_BUCKETS) {
      byBucket[bucket].weightBps = Number(
        (byBucket[bucket].investableValueMinor * 10_000n + investableAssetsMinor / 2n) / investableAssetsMinor,
      );
    }
  }

  const unresolvedHoldings = holdings.filter((holding) => holding.needsBreakdown).map((holding) => holding.name);

  return {
    totalValueMinor,
    reservedCashMinor,
    investableAssetsMinor,
    byBucket,
    concentrationComplete: unresolvedHoldings.length === 0,
    unresolvedHoldings,
  };
}

export function formatMoneyMinor(valueMinor: bigint, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(valueMinor) / 100);
}

export function formatBps(valueBps: number): string {
  return `${(valueBps / 100).toFixed(1)}%`;
}
