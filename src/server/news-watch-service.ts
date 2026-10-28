import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { dataSourceStatus, holdings, holdingTheses, newsItems, thesisBreakers, thesisEvents } from "@/db/schema";
import {
  breakerLabels,
  buildDraftMessages,
  clearedBefore,
  buildQueryMessages,
  buildScreeningMessages,
  buildSearchQuery,
  buildVerificationMessages,
  dayBefore,
  decideTrigger,
  fallbackQueries,
  headlineKey,
  parseDraft,
  parseQueries,
  parseScreening,
  parseVerification,
  selectCandidates,
  NEWS_MAX_AGE_DAYS,
  NEWS_MAX_VERIFICATIONS,
  NEWS_RESULTS_PER_QUERY,
  NEWS_SCAN_INTERVAL_HOURS,
  type HoldingForPrompt,
  type NewsVerdict,
  type SearchHit,
} from "@/domain/news-watch";
import type { AssetBucket } from "@/domain/types";
import { BUCKET_LABELS, instrumentTypeLabel } from "@/lib/presentation";
import { shanghaiDate } from "@/lib/shanghai";
import { DeepSeekClient, DeepSeekError, type NewsClient } from "@/providers/deepseek";
import { dismissAiTrigger, recordThesisEvent } from "./thesis-service";

/**
 * AI 新闻监控（docs/hengcang_v2_allocation_fundamentals_thesis.md §7）：
 * 每份投资逻辑每天扫描一次——生成搜索词 → DeepSeek 搜索最近 30 天 → 模型按摘要初筛 →
 * 「可能触发」的文章带正文复核 → 满足全部规则（见 domain/news-watch.ts）才自动触发失效条件，
 * 否则留给你一键确认或忽略。只发送持仓名称、代码、投资逻辑和失效条件，不发送金额与仓位。
 */
export const NEWS_STATUS_PROVIDER = "deepseek-news";
const HOUR_MS = 60 * 60 * 1000;
/** 无关文章只为去重保留；搜索只看最近 30 天，60 天前的无关记录可以清掉 */
const IRRELEVANT_RETENTION_DAYS = 60;

export class NewsWatchError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "NOT_PENDING" | "INVALID_DRAFT",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NewsWatchError";
  }
}

export interface NewsScanReport {
  /** IDLE：没有到期需要扫描的逻辑（状态行不变） */
  status: "READY" | "DEGRADED" | "ERROR" | "NOT_CONFIGURED" | "IDLE";
  scanned: number;
  skipped: number;
  newItems: number;
  triggered: number;
  possible: number;
  warnings: string[];
}

type ThesisRow = typeof holdingTheses.$inferSelect;
type HoldingRow = typeof holdings.$inferSelect;
export type NewsItemRow = typeof newsItems.$inferSelect;

export function isNewsWatchConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Key 无效或余额不足：后面的逻辑也一定失败，整轮停止。 */
function isAccountError(error: unknown): boolean {
  return error instanceof DeepSeekError && (error.status === 401 || error.status === 402);
}

function clip(value: string, maxChars: number): string {
  return [...value].slice(0, maxChars).join("");
}

function promptHolding(holding: HoldingRow): HoldingForPrompt {
  return { name: holding.name, symbol: holding.symbol, instrumentLabel: instrumentTypeLabel(holding.instrumentType) };
}

/** 事件日期不能晚于今天（记录规则同手工记录） */
function notAfter(day: string, today: string): string {
  return day > today ? today : day;
}

function eventSummary(summary: string, evidence: string | null): string {
  return clip(evidence ? `${summary}\n原文：「${evidence}」` : summary, 500);
}

function saveNewsStatus(status: NewsScanReport["status"], timestamp: string, errors: string[], model: string | null) {
  const db = getDatabase();
  const previous = db.select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, NEWS_STATUS_PROVIDER)).get();
  const values = {
    enabled: status !== "NOT_CONFIGURED",
    status,
    lastAttemptAt: timestamp,
    lastSuccessAt: status === "READY" || status === "DEGRADED" ? timestamp : previous?.lastSuccessAt ?? null,
    lastErrorCode: status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : errors.length > 0 ? "PARTIAL_FAILURE" : null,
    lastErrorMessage: errors.length > 0 ? errors.slice(0, 8).join("；") : null,
    capabilitiesJson: JSON.stringify(model ? { 搜索: "DeepSeek Search", 正文: "DeepSeek Fetch", 判断模型: model } : {}),
    updatedAt: timestamp,
  };
  db.insert(dataSourceStatus)
    .values({ id: `provider-${NEWS_STATUS_PROVIDER}`, provider: NEWS_STATUS_PROVIDER, ...values })
    .onConflictDoUpdate({ target: dataSourceStatus.provider, set: values })
    .run();
}

function storedQueries(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** 搜索词随逻辑和条件变化：指纹相同就沿用；模型失败时用兜底词，但不记指纹，下一轮再试。 */
async function ensureQueries(client: NewsClient, thesis: ThesisRow, holding: HoldingRow, breakers: string[], warnings: string[]): Promise<string[]> {
  const basis = createHash("sha256")
    .update(JSON.stringify({ name: holding.name, symbol: holding.symbol, thesis: thesis.thesis, breakers }))
    .digest("hex")
    .slice(0, 32);
  const cached = storedQueries(thesis.newsQueriesJson);
  if (thesis.newsQueriesBasis === basis && cached.length > 0) return cached;
  let queries: string[] = [];
  try {
    queries = parseQueries(await client.chatJson(buildQueryMessages(promptHolding(holding), thesis.thesis, breakers)), holding.name);
  } catch (error) {
    if (isAccountError(error)) throw error;
    warnings.push(`生成搜索词失败，先用默认搜索词：${errorText(error)}`);
  }
  const generated = queries.length > 0;
  if (!generated) queries = fallbackQueries(holding.name, breakers);
  getDatabase()
    .update(holdingTheses)
    .set({ newsQueriesJson: JSON.stringify(queries), newsQueriesBasis: generated ? basis : null })
    .where(eq(holdingTheses.id, thesis.id))
    .run();
  return queries;
}

interface Decision {
  verdict: NewsVerdict;
  breakerId: string | null;
  summary: string;
  evidence: string | null;
  occurredOn: string | null;
}

async function scanThesis(client: NewsClient, thesis: ThesisRow, holding: HoldingRow, now: Date) {
  const db = getDatabase();
  const timestamp = now.toISOString();
  const today = shanghaiDate(now);
  const warnings: string[] = [];
  const breakers = db.select().from(thesisBreakers).where(eq(thesisBreakers.thesisId, thesis.id)).orderBy(asc(thesisBreakers.position)).all();
  // 每条条件最近一次被你复核或撤销误判的日期：不晚于这一天的事件不再触发它（同一条新闻换个网站转载）
  const dismissals = db.select({ breakerId: thesisEvents.breakerId, recordedAt: thesisEvents.recordedAt })
    .from(thesisEvents)
    .where(and(eq(thesisEvents.thesisId, thesis.id), eq(thesisEvents.kind, "DISMISS")))
    .all();
  const clearedOn = new Map<string, string>();
  for (const breaker of breakers) {
    const latest = [breaker.lastReviewedAt, ...dismissals.filter((row) => row.breakerId === breaker.id).map((row) => row.recordedAt)]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    if (latest) clearedOn.set(breaker.id, shanghaiDate(new Date(latest)));
  }
  // 条件写下或最后改写的日期：早于这一天发生的事件可能写下时就已成立，只提示、不自动触发
  const writtenOn = new Map(breakers.map((breaker) => [breaker.id, shanghaiDate(new Date(breaker.updatedAt))]));
  const queries = await ensureQueries(client, thesis, holding, breakers.map((breaker) => breaker.description), warnings);

  const afterDay = dayBefore(today, NEWS_MAX_AGE_DAYS);
  const hits: SearchHit[] = [];
  let searchFailures = 0;
  for (const query of queries) {
    try {
      hits.push(...await client.search(buildSearchQuery(query, afterDay), { count: NEWS_RESULTS_PER_QUERY, needContent: true }));
    } catch (error) {
      if (isAccountError(error)) throw error;
      searchFailures += 1;
      warnings.push(`搜索「${query}」失败：${errorText(error)}`);
    }
  }
  // 一个搜索都没成功：不算扫描过，下一轮重试
  if (queries.length > 0 && searchFailures === queries.length) throw new Error(warnings.at(-1) ?? "搜索全部失败");

  const seenRows = db.select({ url: newsItems.url, title: newsItems.title }).from(newsItems).where(eq(newsItems.thesisId, thesis.id)).all();
  const seen = new Set(seenRows.map((row) => row.url));
  const seenHeadlines = new Set(seenRows.map((row) => headlineKey(row.title)).filter(Boolean));
  const candidates = selectCandidates(hits, seen, today, { seenHeadlines });
  let triggered = 0;
  let possible = 0;
  if (candidates.length > 0) {
    // 只把尚未触发的条件交给模型（已触发的已经在暂停中）
    const active = breakers.filter((breaker) => breaker.status !== "TRIGGERED");
    const labels = breakerLabels(active);
    const screening = parseScreening(
      await client.chatJson(buildScreeningMessages({
        today,
        holding: promptHolding(holding),
        thesis: thesis.thesis,
        breakers: active.map((breaker, index) => ({ label: `B${index + 1}`, description: breaker.description })),
        candidates,
      })),
      candidates.length,
      labels,
    );
    // 格式不对就让这一轮失败（不标记扫描过，下一轮重试），不能把全部文章当「无关」标成看过
    if (!screening) throw new Error("模型初筛返回的格式不对，下一轮重试");
    const decisions = new Map<number, Decision>(screening.map((item) => {
      // 已复核 / 撤销过的条件：更早发布的文章只算相关，不再进待确认
      const stale = item.verdict === "POSSIBLE" && item.breakerId !== null && clearedBefore(candidates[item.index].publishedOn, clearedOn.get(item.breakerId));
      return [item.index, {
        verdict: stale ? "RELATED" : item.verdict,
        breakerId: stale ? null : item.breakerId,
        summary: item.summary,
        evidence: null,
        occurredOn: null,
      }];
    }));

    // 带正文复核：候选已按 rerank_score 排序，最多复核前几篇「可能触发」，其余留给你确认
    const triggeredNow = new Set<string>();
    for (const item of screening.filter((entry) => decisions.get(entry.index)?.verdict === "POSSIBLE").slice(0, NEWS_MAX_VERIFICATIONS)) {
      const candidate = candidates[item.index];
      const breaker = active.find((entry) => entry.id === item.breakerId);
      if (!breaker) continue;
      try {
        let content = candidate.content;
        if (!content.trim()) content = (await client.fetchPage(candidate.url)).content;
        if (!content.trim()) continue;
        // 只有这一步可能自动触发：开低强度思考换判断质量（其余调用关闭思考，保证「立即检查」够快）
        const verification = parseVerification(await client.chatJson(buildVerificationMessages({
          today,
          holding: promptHolding(holding),
          breakerDescription: breaker.description,
          candidate,
          content,
        }), { thinking: true }));
        const decision = decideTrigger({
          verification,
          content,
          publishedOn: candidate.publishedOn,
          authority: candidate.authority,
          breakerActive: !triggeredNow.has(breaker.id),
          clearedOn: clearedOn.get(breaker.id) ?? null,
          writtenOn: writtenOn.get(breaker.id) ?? null,
          today,
        });
        if (decision.verdict === "TRIGGER") triggeredNow.add(breaker.id);
        decisions.set(item.index, {
          verdict: decision.verdict,
          breakerId: decision.verdict === "RELATED" ? null : breaker.id,
          summary: verification.summary || item.summary,
          evidence: verification.evidence || null,
          occurredOn: verification.occurredOn,
        });
      } catch (error) {
        if (isAccountError(error)) throw error;
        warnings.push(`复核「${candidate.title}」失败，留作待确认：${errorText(error)}`);
      }
    }

    // 每条条件最多留一条待确认：同一轮已触发的、或之前已有待确认新闻的条件，其余文章只算相关（同一事实常被多家转载）
    const pendingBreakers = new Set(
      db.select({ breakerId: newsItems.breakerId }).from(newsItems)
        .where(and(eq(newsItems.thesisId, thesis.id), eq(newsItems.verdict, "POSSIBLE"), eq(newsItems.status, "OPEN")))
        .all()
        .flatMap((row) => row.breakerId ? [row.breakerId] : []),
    );
    for (const decision of decisions.values()) if (decision.verdict === "TRIGGER" && decision.breakerId) pendingBreakers.add(decision.breakerId);
    for (const [index] of candidates.entries()) {
      const decision = decisions.get(index) as Decision;
      if (decision.verdict !== "POSSIBLE" || !decision.breakerId) continue;
      if (pendingBreakers.has(decision.breakerId)) decisions.set(index, { ...decision, verdict: "RELATED", breakerId: null });
      else pendingBreakers.add(decision.breakerId);
    }

    for (const [index, candidate] of candidates.entries()) {
      const decision = decisions.get(index) as Decision;
      let eventId: string | null = null;
      if (decision.verdict === "TRIGGER" && decision.breakerId) {
        const { event } = await recordThesisEvent(holding.id, {
          kind: "NEWS",
          occurredOn: notAfter(decision.occurredOn ?? candidate.publishedOn ?? today, today),
          summary: eventSummary(decision.summary || candidate.title, decision.evidence),
          sourceUrl: candidate.url,
          breakerId: decision.breakerId,
        }, now, "AI");
        eventId = event.id;
        triggered += 1;
      }
      if (decision.verdict === "POSSIBLE") possible += 1;
      db.insert(newsItems).values({
        id: crypto.randomUUID(),
        thesisId: thesis.id,
        url: candidate.url,
        title: clip(candidate.title, 300),
        siteName: candidate.siteName ? clip(candidate.siteName, 100) : null,
        publishedOn: candidate.publishedOn,
        summary: decision.summary || clip((candidate.snippet || candidate.summary).replace(/\s+/g, " ").trim(), 200) || clip(candidate.title, 200),
        verdict: decision.verdict,
        breakerId: decision.breakerId,
        evidence: decision.evidence,
        authority: candidate.authority,
        eventId,
        status: "OPEN",
        foundAt: timestamp,
      }).onConflictDoNothing().run();
    }
  }

  const cutoff = new Date(now.getTime() - IRRELEVANT_RETENTION_DAYS * 24 * HOUR_MS).toISOString();
  db.delete(newsItems).where(and(eq(newsItems.thesisId, thesis.id), eq(newsItems.verdict, "IRRELEVANT"), lt(newsItems.foundAt, cutoff))).run();
  db.update(holdingTheses).set({ newsScannedAt: timestamp }).where(eq(holdingTheses.id, thesis.id)).run();
  return { newItems: candidates.length, triggered, possible, warnings };
}

/**
 * 扫描新闻。默认每份逻辑距上次扫描满 20 小时才扫（worker 每 6 小时调用一次）；force 立即扫描。
 * 没配置 DEEPSEEK_API_KEY 时返回 NOT_CONFIGURED，其它功能不受影响。
 */
export async function scanNews(options: { holdingId?: string; force?: boolean; now?: Date; client?: NewsClient | null } = {}): Promise<NewsScanReport> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const client = options.client === undefined ? DeepSeekClient.fromEnv() : options.client;
  const report: NewsScanReport = { status: "READY", scanned: 0, skipped: 0, newItems: 0, triggered: 0, possible: 0, warnings: [] };
  if (!client) {
    saveNewsStatus("NOT_CONFIGURED", timestamp, ["尚未在本机环境中配置 DEEPSEEK_API_KEY"], null);
    return { ...report, status: "NOT_CONFIGURED" };
  }
  const rows = getDatabase()
    .select({ thesis: holdingTheses, holding: holdings })
    .from(holdingTheses)
    .innerJoin(holdings, eq(holdings.id, holdingTheses.holdingId))
    .where(and(eq(holdingTheses.portfolioId, DEFAULT_PORTFOLIO_ID), options.holdingId ? eq(holdingTheses.holdingId, options.holdingId) : undefined))
    .all();
  let failures = 0;
  for (const { thesis, holding } of rows) {
    const scannedAt = thesis.newsScannedAt ? Date.parse(thesis.newsScannedAt) : Number.NaN;
    if (!options.force && Number.isFinite(scannedAt) && now.getTime() - scannedAt < NEWS_SCAN_INTERVAL_HOURS * HOUR_MS) {
      report.skipped += 1;
      continue;
    }
    try {
      const result = await scanThesis(client, thesis, holding, now);
      report.scanned += 1;
      report.newItems += result.newItems;
      report.triggered += result.triggered;
      report.possible += result.possible;
      report.warnings.push(...result.warnings.map((warning) => `${holding.name}：${warning}`));
    } catch (error) {
      failures += 1;
      report.warnings.push(`${holding.name}：${errorText(error)}`);
      if (isAccountError(error)) break;
    }
  }
  if (report.scanned === 0 && failures === 0) return { ...report, status: "IDLE" };
  const status = report.scanned === 0 ? "ERROR" : report.warnings.length > 0 ? "DEGRADED" : "READY";
  saveNewsStatus(status, timestamp, report.warnings, client.model);
  return { ...report, status };
}

/**
 * 详情页展示：等你确认的「可能触发」全部列在最前（否则被新文章挤出列表后，仪表盘提醒就没处处理），
 * 其余除「无关」外取最近若干条，新的在前。
 */
export function listNewsItems(thesisId: string, limit = 30): NewsItemRow[] {
  const db = getDatabase();
  const pendingCondition = and(eq(newsItems.thesisId, thesisId), eq(newsItems.verdict, "POSSIBLE"), eq(newsItems.status, "OPEN"));
  const pending = db.select().from(newsItems).where(pendingCondition).orderBy(desc(newsItems.foundAt), desc(newsItems.publishedOn)).all();
  const pendingIds = new Set(pending.map((item) => item.id));
  const recent = db
    .select()
    .from(newsItems)
    .where(and(eq(newsItems.thesisId, thesisId), ne(newsItems.verdict, "IRRELEVANT")))
    .orderBy(desc(newsItems.foundAt), desc(newsItems.publishedOn))
    .limit(limit)
    .all()
    .filter((item) => !pendingIds.has(item.id));
  return [...pending, ...recent];
}

/** 触发某条条件的那篇新闻（按事件 id 找；详情页展示证据和「误判，撤销」用）。 */
export function newsItemsForEvents(eventIds: string[]): Map<string, NewsItemRow> {
  if (eventIds.length === 0) return new Map();
  const rows = getDatabase().select().from(newsItems).where(inArray(newsItems.eventId, eventIds)).all();
  return new Map(rows.map((row) => [row.eventId as string, row]));
}

function findItemWithHolding(newsItemId: string) {
  return getDatabase()
    .select({ item: newsItems, holdingId: holdingTheses.holdingId })
    .from(newsItems)
    .innerJoin(holdingTheses, eq(holdingTheses.id, newsItems.thesisId))
    .where(and(eq(newsItems.id, newsItemId), eq(holdingTheses.portfolioId, DEFAULT_PORTFOLIO_ID)))
    .get();
}

/** 你确认「可能触发」：按 AI 消息记录并触发对应条件（之后同样可以一键撤销）。 */
export async function confirmNewsItem(newsItemId: string, now = new Date()) {
  const found = findItemWithHolding(newsItemId);
  if (!found) throw new NewsWatchError("NOT_FOUND", "新闻不存在", 404);
  const { item, holdingId } = found;
  if (item.verdict !== "POSSIBLE" || item.status !== "OPEN" || !item.breakerId) {
    throw new NewsWatchError("NOT_PENDING", "这条新闻已经处理过，或对应的条件已被删除", 409);
  }
  const today = shanghaiDate(now);
  const { event } = await recordThesisEvent(holdingId, {
    kind: "NEWS",
    occurredOn: notAfter(item.publishedOn ?? today, today),
    summary: eventSummary(item.summary, item.evidence),
    sourceUrl: item.url,
    breakerId: item.breakerId,
  }, now, "AI");
  getDatabase().update(newsItems).set({ status: "CONFIRMED", eventId: event.id }).where(eq(newsItems.id, item.id)).run();
}

/**
 * 忽略「可能触发」，或撤销由这条新闻触发的暂停（误判）。撤销记 DISMISS 事件，不算复核。
 */
export async function dismissNewsItem(newsItemId: string, now = new Date()) {
  const found = findItemWithHolding(newsItemId);
  if (!found) throw new NewsWatchError("NOT_FOUND", "新闻不存在", 404);
  const { item, holdingId } = found;
  if (item.status === "DISMISSED") throw new NewsWatchError("NOT_PENDING", "这条新闻已经忽略或撤销过", 409);
  const breaker = item.breakerId
    ? getDatabase().select().from(thesisBreakers).where(eq(thesisBreakers.id, item.breakerId)).get()
    : undefined;
  const stillTriggeredByThis = Boolean(item.eventId) && breaker?.status === "TRIGGERED" && breaker.triggeredByEventId === item.eventId;
  if (stillTriggeredByThis && breaker) {
    await dismissAiTrigger(holdingId, breaker.id, item.title, now);
  } else if (item.verdict !== "POSSIBLE" || item.status !== "OPEN") {
    throw new NewsWatchError("NOT_PENDING", "这条新闻已经处理过", 409);
  }
  getDatabase().update(newsItems).set({ status: "DISMISSED" }).where(eq(newsItems.id, item.id)).run();
}

/** AI 起草投资逻辑与失效条件：只返回草稿，保存与否由你决定。 */
export async function draftThesis(holdingId: string, client: NewsClient | null = DeepSeekClient.fromEnv()) {
  if (!client) throw new NewsWatchError("NOT_CONFIGURED", "尚未在本机环境中配置 DEEPSEEK_API_KEY", 409);
  const holding = getDatabase()
    .select()
    .from(holdings)
    .where(and(eq(holdings.id, holdingId), eq(holdings.portfolioId, DEFAULT_PORTFOLIO_ID)))
    .get();
  if (!holding) throw new NewsWatchError("NOT_FOUND", "持仓不存在", 404);
  const draft = parseDraft(await client.chatJson(buildDraftMessages({
    ...promptHolding(holding),
    bucketLabel: BUCKET_LABELS[holding.assetBucket as AssetBucket] ?? holding.assetBucket,
    theme: holding.theme,
  })), 5);
  if (!draft) throw new NewsWatchError("INVALID_DRAFT", "AI 没有给出可用的草稿，请再试一次", 502);
  return draft;
}
