import { createHash } from "node:crypto";
import { z } from "zod";
import { CANONICAL_METRIC_KEYS, METRIC_CATALOG, type CanonicalMetricKey } from "./catalog";
import { type ScorableAssetBucket } from "@/domain/types";

export type ManualImportFormat = "csv" | "json";

export interface ManualObservationInput {
  subjectType: "ASSET_BUCKET";
  subjectId: ScorableAssetBucket;
  metricKey: CanonicalMetricKey;
  value: string;
  unit: string;
  observedAt: string;
  availableAt: string;
  asOf: string;
}

export interface ImportIssue {
  row: number;
  field: string;
  message: string;
}

export interface ManualImportPreview {
  digest: string;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  rows: ManualObservationInput[];
  errors: ImportIssue[];
  summary: Array<{ subjectId: ScorableAssetBucket; metricCount: number; observationCount: number; latestAsOf: string }>;
}

/** 严格 ISO 8601 含时区的时间戳（M7；observedAt/availableAt 共用）。 */
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const rowSchema = z.object({
  subjectType: z.literal("ASSET_BUCKET"),
  subjectId: z.enum(["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"]),
  metricKey: z.enum(CANONICAL_METRIC_KEYS as [CanonicalMetricKey, ...CanonicalMetricKey[]]),
  value: z.string().trim().regex(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/, "必须是有限十进制数"),
  unit: z.string().trim().min(1).max(32),
  // 严格 ISO 8601 含时区（M7）：松散 Date.parse(“2026-8-9”) 可过，但下游 slice(0,10) 字典序比较会把该行静默排除出评分
  observedAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, "必须是带时区的 ISO 8601 时间（如 2026-08-09T15:00:00+08:00）").refine((value) => Number.isFinite(Date.parse(value)), "必须是有效时间"),
  availableAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, "必须是带时区的 ISO 8601 时间").refine((value) => Number.isFinite(Date.parse(value)), "必须是有效时间"),
  asOf: z.iso.date(),
});

const HEADER_ALIASES: Record<string, keyof ManualObservationInput> = {
  subject_type: "subjectType",
  subjecttype: "subjectType",
  subject_id: "subjectId",
  subjectid: "subjectId",
  metric_key: "metricKey",
  metrickey: "metricKey",
  value: "value",
  unit: "unit",
  observed_at: "observedAt",
  observedat: "observedAt",
  available_at: "availableAt",
  availableat: "availableAt",
  as_of: "asOf",
  asof: "asOf",
};

function parseCsvMatrix(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV 包含未闭合的引号");
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function parseCsv(content: string): unknown[] {
  const matrix = parseCsvMatrix(content.replace(/^\uFEFF/, ""));
  if (matrix.length === 0) return [];
  const headers = matrix[0].map((header) => HEADER_ALIASES[header.trim().toLowerCase()]);
  return matrix.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header ?? `unknown_${index}`, values[index] ?? ""])),
  );
}

function parseJson(content: string): unknown[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && "rows" in parsed && Array.isArray((parsed as { rows: unknown }).rows)) {
    return (parsed as { rows: unknown[] }).rows;
  }
  throw new Error("JSON 必须是数组，或包含 rows 数组的对象");
}

function normalizeRow(value: unknown): Record<string, unknown> {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(raw)) {
    normalized[HEADER_ALIASES[key.toLowerCase()] ?? key] = item;
  }
  const asOf = String(normalized.asOf ?? "").trim();
  const metricKey = String(normalized.metricKey ?? "").trim().toUpperCase() as CanonicalMetricKey;
  normalized.subjectType = String(normalized.subjectType || "ASSET_BUCKET").trim().toUpperCase();
  normalized.subjectId = String(normalized.subjectId ?? "").trim().toUpperCase();
  normalized.metricKey = metricKey;
  normalized.value = String(normalized.value ?? "").trim();
  normalized.unit = String(normalized.unit || METRIC_CATALOG[metricKey]?.defaultUnit || "provider_defined").trim();
  normalized.asOf = asOf;
  normalized.observedAt = String(normalized.observedAt || `${asOf}T00:00:00Z`).trim();
  normalized.availableAt = String(normalized.availableAt || `${asOf}T23:59:59Z`).trim();
  return normalized;
}

function identity(row: ManualObservationInput): string {
  return `${row.subjectType}|${row.subjectId}|${row.metricKey}|${row.asOf}`;
}

export function previewManualObservationImport(format: ManualImportFormat, content: string): ManualImportPreview {
  const errors: ImportIssue[] = [];
  let rawRows: unknown[] = [];
  try {
    rawRows = format === "csv" ? parseCsv(content) : parseJson(content);
  } catch (error) {
    errors.push({ row: 0, field: "content", message: error instanceof Error ? error.message : "无法解析文件" });
  }

  const rows: ManualObservationInput[] = [];
  const byIdentity = new Map<string, ManualObservationInput>();
  let duplicateRows = 0;

  rawRows.forEach((raw, index) => {
    const parsed = rowSchema.safeParse(normalizeRow(raw));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ row: index + 2, field: issue.path.join(".") || "row", message: issue.message });
      }
      return;
    }
    const numericValue = Number(parsed.data.value);
    if (!Number.isFinite(numericValue)) {
      errors.push({ row: index + 2, field: "value", message: "必须是有限数值" });
      return;
    }
    const definition = METRIC_CATALOG[parsed.data.metricKey];
    if ("scoreRange" in definition && definition.scoreRange && (numericValue < 0 || numericValue > 100)) {
      errors.push({ row: index + 2, field: "value", message: "评分型指标必须位于 0–100" });
      return;
    }
    if (parsed.data.availableAt.slice(0, 10) < parsed.data.asOf) {
      errors.push({ row: index + 2, field: "availableAt", message: "可用时间不能早于数据日期" });
      return;
    }

    const normalized = parsed.data as ManualObservationInput;
    const key = identity(normalized);
    const existing = byIdentity.get(key);
    if (existing) {
      if (existing.value === normalized.value && existing.unit === normalized.unit && existing.availableAt === normalized.availableAt) {
        duplicateRows += 1;
      } else {
        errors.push({ row: index + 2, field: "metricKey", message: "同一资产桶、指标和日期存在冲突值" });
      }
      return;
    }
    byIdentity.set(key, normalized);
    rows.push(normalized);
  });

  const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const grouped = new Map<ScorableAssetBucket, { keys: Set<string>; count: number; latest: string }>();
  for (const row of rows) {
    const current = grouped.get(row.subjectId) ?? { keys: new Set<string>(), count: 0, latest: row.asOf };
    current.keys.add(row.metricKey);
    current.count += 1;
    if (row.asOf > current.latest) current.latest = row.asOf;
    grouped.set(row.subjectId, current);
  }

  return {
    digest,
    totalRows: rawRows.length,
    validRows: rows.length,
    duplicateRows,
    rows,
    errors,
    summary: Array.from(grouped, ([subjectId, value]) => ({
      subjectId,
      metricCount: value.keys.size,
      observationCount: value.count,
      latestAsOf: value.latest,
    })),
  };
}
