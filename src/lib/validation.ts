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

/**
 * 补丁字段必须显式 optional 且【不带 default】：zod v4 中 .partial() 会保留
 * ZodDefault 的填充行为——safeParse({}) 会产出全部默认键，导致空补丁通过校验，
 * 且任何单字段修改都会把 isApproximate/needsBreakdown 等布尔标志重置为默认值。
 * 这里手写 optional 字段，保证"未提供的键保持缺失"，只更新调用方真正传入的字段。
 */
export const holdingPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    symbol: z.string().trim().max(32).optional().nullable(),
    instrumentType: z.string().trim().min(1).max(40).optional(),
    assetBucket: z.enum(ASSET_BUCKETS).optional(),
    region: z.string().trim().min(1).max(24).optional(),
    theme: z.string().trim().max(80).optional().nullable(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/).optional().nullable(),
    costBasisMinor: z.string().regex(/^\d+$/).optional().nullable(),
    marketValueMinor: z.string().regex(/^\d+$/).optional(),
    currency: z.string().length(3).optional(),
    isSingleStock: z.boolean().optional(),
    isThematicEtf: z.boolean().optional(),
    isApproximate: z.boolean().optional(),
    needsBreakdown: z.boolean().optional(),
    asOf: z.iso.date().optional(),
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine((value) => Object.keys(value).length > 0, {
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
