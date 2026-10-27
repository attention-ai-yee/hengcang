import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID, getPortfolioRecord, getRiskLimits, listAllocationTargets, listHoldings } from "@/db/queries";
import { portfolios } from "@/db/schema";
import { DEFAULT_ALLOCATION_BANDS, DEFAULT_RISK_LIMITS } from "@/domain/settings";
import { DEFAULT_SCORING_CONFIG } from "@/domain/scoring";
import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { reservedCashPayloadSchema } from "@/lib/validation";

/** 返回数据库里实际生效的目标与上限（Code Review L17：原来返回写死的默认值，改过目标的组合会对不上）；默认值另列。 */
export async function GET() {
  const [portfolio, targets, limits] = await Promise.all([getPortfolioRecord(), listAllocationTargets(), getRiskLimits()]);
  return apiSuccess({
    baseCurrency: "CNY",
    timezone: "Asia/Shanghai",
    allocationBands: targets.length > 0
      ? Object.fromEntries(targets.map((target) => [target.assetBucket, { targetBps: target.targetBps, minBps: target.minBps, maxBps: target.maxBps }]))
      : DEFAULT_ALLOCATION_BANDS,
    riskLimits: limits
      ? { singleStockBps: limits.singleStockBps, thematicEtfBps: limits.thematicEtfBps, themeBps: limits.themeBps, cooldownDays: limits.cooldownDays }
      : DEFAULT_RISK_LIMITS,
    defaults: { allocationBands: DEFAULT_ALLOCATION_BANDS, riskLimits: DEFAULT_RISK_LIMITS },
    scoring: DEFAULT_SCORING_CONFIG,
    reservedCashMinor: portfolio?.reservedCashMinor ?? "0",
    providers: {
      manual: true,
      tushare: Boolean(process.env.TUSHARE_TOKEN),
      fred: Boolean(process.env.FRED_API_KEY),
      twelveData: Boolean(process.env.TWELVE_DATA_API_KEY),
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    },
  });
}

export async function PATCH(request: Request) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const parsed = reservedCashPayloadSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "预留资金格式无效", 422, zodFields(parsed.error));

  const [portfolio, holdings] = await Promise.all([getPortfolioRecord(), listHoldings()]);
  if (!portfolio) return apiError("PORTFOLIO_NOT_FOUND", "未找到投资组合", 404);
  const reserved = BigInt(parsed.data.reservedCashMinor);
  const total = holdings.reduce((sum, holding) => sum + BigInt(holding.marketValueMinor), 0n);
  const cashAndBonds = holdings
    .filter((holding) => holding.assetBucket === "CASH_BONDS")
    .reduce((sum, holding) => sum + BigInt(holding.marketValueMinor), 0n);
  if (reserved > total) return apiError("RESERVED_CASH_EXCEEDS_TOTAL", "预留资金不能超过金融资产总额", 422);
  if (reserved > cashAndBonds) return apiError("RESERVED_CASH_NOT_FUNDED", "预留资金不能超过现金与债券桶金额", 422);

  getDatabase()
    .update(portfolios)
    .set({ reservedCashMinor: reserved.toString(), updatedAt: new Date().toISOString() })
    .where(eq(portfolios.id, DEFAULT_PORTFOLIO_ID))
    .run();
  return apiSuccess({ reservedCashMinor: reserved.toString() });
}
