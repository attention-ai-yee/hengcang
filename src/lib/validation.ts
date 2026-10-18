import { z } from "zod";
import { ASSET_BUCKETS } from "@/domain/types";
import { shanghaiDate } from "@/lib/shanghai";

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
  // 手工评分只作为「今天」的低可信度兜底：过去日期会以 (portfolio,bucket,asOf) upsert
  // 覆盖同日自动快照并把 candidateState 写进候选链，污染 3 日确认与回测状态（Code Review M9 加严）。
  asOf: z.iso.date().refine((value) => value === shanghaiDate(), "手工评分只允许记录当天（上海时区）"),
});

export const reservedCashPayloadSchema = z.object({
  reservedCashMinor: z.string().regex(/^\d+$/),
});

export const DECISION_ACTIONS = ["ADD", "REDUCE", "HOLD", "PAUSE"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** 决策动作的中文文案（表单/列表共用） */
export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  ADD: "加仓",
  REDUCE: "减仓",
  HOLD: "保持",
  PAUSE: "暂停新增",
};

/** 决策动作 → 建议方向；冷却抑制只对 ADD / REDUCE 同方向生效。 */
export function decisionDirectionForAction(action: DecisionAction): "ADD" | "REDUCE" | "NONE" {
  if (action === "ADD") return "ADD";
  if (action === "REDUCE") return "REDUCE";
  return "NONE";
}

export const decisionPayloadSchema = z.object({
  assetBucket: z.enum(ASSET_BUCKETS),
  action: z.enum(DECISION_ACTIONS),
  rationale: z.string().trim().min(1, "请填写决策理由").max(500, "决策理由不能超过 500 字"),
  // 可选；缺省时服务端写入上海当前时间。必须带时区，避免点内时间歧义。
  decidedAt: z.iso.datetime({ offset: true, error: "决策时间必须是带时区的 ISO 8601 时间" }).optional(),
});
