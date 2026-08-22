import { getDatabase } from "../src/db/client";
import {
  allocationTargets,
  dataSourceStatus,
  holdings,
  portfolios,
  riskLimits,
} from "../src/db/schema";
import { DEFAULT_ALLOCATION_BANDS, DEFAULT_RISK_LIMITS } from "../src/domain/settings";
import { ASSET_BUCKETS } from "../src/domain/types";

const db = getDatabase();
const now = new Date().toISOString();
const asOf = now.slice(0, 10);

db.insert(portfolios)
  .values({
    id: "default",
    name: "我的投资组合",
    baseCurrency: "CNY",
    reservedCashMinor: "0",
    onboardingCompletedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoNothing()
  .run();

for (const bucket of ASSET_BUCKETS) {
  const band = DEFAULT_ALLOCATION_BANDS[bucket];
  db.insert(allocationTargets)
    .values({
      id: `target-${bucket.toLowerCase()}`,
      portfolioId: "default",
      assetBucket: bucket,
      targetBps: band.targetBps,
      minBps: band.minBps,
      maxBps: band.maxBps,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [allocationTargets.portfolioId, allocationTargets.assetBucket],
      set: { targetBps: band.targetBps, minBps: band.minBps, maxBps: band.maxBps, updatedAt: now },
    })
    .run();
}

db.insert(riskLimits)
  .values({
    id: "risk-default",
    portfolioId: "default",
    ...DEFAULT_RISK_LIMITS,
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoNothing()
  .run();

const seedHoldings = [
  { id: "holding-cash", name: "现金", value: "8000000", bucket: "CASH_BONDS", type: "CASH" },
  { id: "holding-stock-account", name: "股票账户总值", value: "22000000", bucket: "TECH_GROWTH", type: "ACCOUNT_AGGREGATE", needsBreakdown: true },
  { id: "holding-bond-fund", name: "债券基金", value: "16000000", bucket: "CASH_BONDS", type: "FUND" },
  { id: "holding-004814", name: "中欧红利优享灵活配置混合A", symbol: "004814", value: "10000000", bucket: "VALUE_DIVIDEND", type: "FUND" },
  { id: "holding-gold", name: "黄金", value: "2000000", bucket: "GOLD", type: "GOLD", approximate: true },
  { id: "holding-other", name: "其他A股科技/A500", value: "1000000", bucket: "OTHER", type: "FUND", approximate: true },
] as const;

for (const item of seedHoldings) {
  db.insert(holdings)
    .values({
      id: item.id,
      portfolioId: "default",
      name: item.name,
      symbol: "symbol" in item ? item.symbol : null,
      instrumentType: item.type,
      assetBucket: item.bucket,
      marketValueMinor: item.value,
      isApproximate: "approximate" in item ? item.approximate : false,
      needsBreakdown: "needsBreakdown" in item ? item.needsBreakdown : false,
      asOf,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

const providers = [
  { id: "manual", enabled: true, capabilities: ["PRICE_SERIES", "VALUATION_METRICS", "FUNDAMENTAL_METRICS", "MACRO_SERIES"] },
  { id: "tushare", enabled: Boolean(process.env.TUSHARE_TOKEN), capabilities: ["PRICE_SERIES", "VALUATION_METRICS", "FUNDAMENTAL_METRICS"] },
  { id: "fred", enabled: Boolean(process.env.FRED_API_KEY), capabilities: ["MACRO_SERIES"] },
  { id: "twelve-data", enabled: Boolean(process.env.TWELVE_DATA_API_KEY), capabilities: ["PRICE_SERIES"] },
] as const;

for (const provider of providers) {
  db.insert(dataSourceStatus)
    .values({
      id: `provider-${provider.id}`,
      provider: provider.id,
      enabled: provider.enabled,
      status: provider.enabled ? "READY" : "NOT_CONFIGURED",
      capabilitiesJson: JSON.stringify(provider.capabilities),
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

console.log("Seed complete: sample holdings are explicitly marked as manual input.");
