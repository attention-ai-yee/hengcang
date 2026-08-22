import { z } from "zod";
import { ASSET_BUCKETS } from "@/domain/types";

export const holdingPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  symbol: z.string().trim().max(32).optional().nullable(),
  instrumentType: z.string().trim().min(1).max(40),
  assetBucket: z.enum(ASSET_BUCKETS),
  region: z.string().trim().min(1).max(24).default("CN"),
  theme: z.string().trim().max(80).optional().nullable(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/).optional().nullable(),
  costBasisMinor: z.string().regex(/^\d+$/).optional().nullable(),
  marketValueMinor: z.string().regex(/^\d+$/),
  currency: z.string().length(3).default("CNY"),
  isSingleStock: z.boolean().default(false),
  isThematicEtf: z.boolean().default(false),
  isApproximate: z.boolean().default(false),
  needsBreakdown: z.boolean().default(false),
  asOf: z.iso.date(),
  notes: z.string().max(1000).optional().nullable(),
});

export const holdingPatchSchema = holdingPayloadSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "至少提供一个需要修改的字段",
});

export const manualScorePayloadSchema = z.object({
  assetBucket: z.enum(["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"]),
  cheapnessScore: z.number().min(0).max(100),
  fundamentalScore: z.number().int().min(0).max(100),
  trendScore: z.number().int().min(0).max(100),
  asOf: z.iso.date(),
});

export const reservedCashPayloadSchema = z.object({
  reservedCashMinor: z.string().regex(/^\d+$/),
});
