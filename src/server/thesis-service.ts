import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { holdings, holdingTheses, signals, thesisBreakers, thesisEvents } from "@/db/schema";
import { needsThesis, planBreakerChanges, reviewDue, thesisStatus, type ThesisStatus } from "@/domain/thesis";
import { shanghaiDate } from "@/lib/shanghai";
import type { thesisEventPayloadSchema, thesisPayloadSchema } from "@/lib/validation";
import { ensureDefaultPortfolioRecord } from "./portfolio-service";

export type ThesisPayload = z.infer<typeof thesisPayloadSchema>;
export type ThesisEventPayload = z.infer<typeof thesisEventPayloadSchema>;

export class ThesisError extends Error {
  constructor(
    readonly code: "HOLDING_NOT_FOUND" | "THESIS_NOT_FOUND" | "UNKNOWN_BREAKER" | "BREAKER_TRIGGERED",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ThesisError";
  }
}

export interface ThesisView {
  holding: typeof holdings.$inferSelect;
  thesis: typeof holdingTheses.$inferSelect | null;
  breakers: Array<typeof thesisBreakers.$inferSelect>;
  events: Array<typeof thesisEvents.$inferSelect>;
  status: ThesisStatus;
  needsThesis: boolean;
  reviewDue: boolean;
  /** 最近一次复核的日期（上海时区）；没有复核为 null */
  lastReviewOn: string | null;
}

function findHolding(holdingId: string) {
  return getDatabase()
    .select()
    .from(holdings)
    .where(and(eq(holdings.id, holdingId), eq(holdings.portfolioId, DEFAULT_PORTFOLIO_ID)))
    .get();
}

function findThesis(holdingId: string) {
  return getDatabase().select().from(holdingTheses).where(eq(holdingTheses.holdingId, holdingId)).get();
}

function lastReviewOn(events: Array<typeof thesisEvents.$inferSelect>): string | null {
  const latest = events
    .filter((event) => event.kind === "REVIEW")
    .reduce<string | null>((max, event) => (!max || event.recordedAt > max ? event.recordedAt : max), null);
  return latest ? shanghaiDate(new Date(latest)) : null;
}

export async function getThesisView(holdingId: string, today = shanghaiDate()): Promise<ThesisView | null> {
  const holding = findHolding(holdingId);
  if (!holding) return null;
  const thesis = findThesis(holdingId) ?? null;
  const db = getDatabase();
  const breakers = thesis
    ? db.select().from(thesisBreakers).where(eq(thesisBreakers.thesisId, thesis.id)).orderBy(asc(thesisBreakers.position), asc(thesisBreakers.createdAt), asc(thesisBreakers.id)).all()
    : [];
  const events = thesis
    ? db.select().from(thesisEvents).where(eq(thesisEvents.thesisId, thesis.id)).orderBy(desc(thesisEvents.recordedAt)).all()
    : [];
  const reviewedOn = lastReviewOn(events);
  return {
    holding,
    thesis,
    breakers,
    events,
    status: thesisStatus({ hasThesis: Boolean(thesis), breakers }),
    needsThesis: needsThesis(holding),
    reviewDue: thesis ? reviewDue({ lastReviewOn: reviewedOn, thesisCreatedAt: thesis.createdAt, today }) : false,
    lastReviewOn: reviewedOn,
  };
}

/**
 * 写入 / 修改投资逻辑与失效条件（同一事务）。已触发的失效条件不能删除或改写，
 * 必须先写复核解除——否则改几个字就能绕过暂停。
 */
export async function saveThesis(holdingId: string, payload: ThesisPayload, now = new Date()): Promise<ThesisView> {
  const holding = findHolding(holdingId);
  if (!holding) throw new ThesisError("HOLDING_NOT_FOUND", "持仓不存在", 404);
  const timestamp = now.toISOString();
  ensureDefaultPortfolioRecord(timestamp);
  const db = getDatabase();
  db.transaction((tx) => {
    let thesis = tx.select().from(holdingTheses).where(eq(holdingTheses.holdingId, holdingId)).get();
    if (thesis) {
      tx.update(holdingTheses).set({ thesis: payload.thesis, updatedAt: timestamp }).where(eq(holdingTheses.id, thesis.id)).run();
    } else {
      thesis = { id: crypto.randomUUID(), portfolioId: DEFAULT_PORTFOLIO_ID, holdingId, thesis: payload.thesis, createdAt: timestamp, updatedAt: timestamp };
      tx.insert(holdingTheses).values(thesis).run();
    }
    const existing = tx.select().from(thesisBreakers).where(eq(thesisBreakers.thesisId, thesis.id)).all();
    const plan = planBreakerChanges(existing, payload.breakers);
    if (!plan.ok) {
      throw plan.error === "BREAKER_TRIGGERED"
        ? new ThesisError("BREAKER_TRIGGERED", "已触发的失效条件不能删除或修改，请先写复核解除", 409)
        : new ThesisError("UNKNOWN_BREAKER", "失效条件不存在或不属于这份投资逻辑", 422);
    }
    for (const item of plan.update) {
      tx.update(thesisBreakers).set({ description: item.description, position: item.position, updatedAt: timestamp }).where(eq(thesisBreakers.id, item.id)).run();
    }
    if (plan.remove.length > 0) tx.delete(thesisBreakers).where(inArray(thesisBreakers.id, plan.remove)).run();
    for (const item of plan.insert) {
      tx.insert(thesisBreakers).values({ id: crypto.randomUUID(), thesisId: thesis.id, description: item.description, position: item.position, status: "ACTIVE", createdAt: timestamp, updatedAt: timestamp }).run();
    }
  });
  return (await getThesisView(holdingId, shanghaiDate(now))) as ThesisView;
}

/**
 * 记录消息或复核：
 * - NEWS 对应到某条失效条件 → 该条触发（TRIGGERED），持仓暂停新增，写 WARNING 信号；
 * - REVIEW 对应到已触发的条件 → 解除（回到 ACTIVE），写 INFO 信号；不对应条件 = 定期复核。
 */
export async function recordThesisEvent(holdingId: string, payload: ThesisEventPayload, now = new Date()) {
  const holding = findHolding(holdingId);
  if (!holding) throw new ThesisError("HOLDING_NOT_FOUND", "持仓不存在", 404);
  const thesis = findThesis(holdingId);
  if (!thesis) throw new ThesisError("THESIS_NOT_FOUND", "请先写下这个持仓的投资逻辑和失效条件", 409);
  const timestamp = now.toISOString();
  const db = getDatabase();
  const breaker = payload.breakerId
    ? db.select().from(thesisBreakers).where(and(eq(thesisBreakers.id, payload.breakerId), eq(thesisBreakers.thesisId, thesis.id))).get()
    : undefined;
  if (payload.breakerId && !breaker) throw new ThesisError("UNKNOWN_BREAKER", "失效条件不存在或不属于这份投资逻辑", 422);

  const event = {
    id: crypto.randomUUID(),
    thesisId: thesis.id,
    kind: payload.kind,
    occurredOn: payload.occurredOn,
    summary: payload.summary,
    sourceUrl: payload.kind === "NEWS" ? payload.sourceUrl ?? null : null,
    breakerId: breaker?.id ?? null,
    recordedAt: timestamp,
  };
  db.transaction((tx) => {
    tx.insert(thesisEvents).values(event).run();
    if (!breaker) return;
    if (payload.kind === "NEWS" && breaker.status !== "TRIGGERED") {
      tx.update(thesisBreakers).set({ status: "TRIGGERED", triggeredAt: timestamp, triggeredByEventId: event.id, updatedAt: timestamp }).where(eq(thesisBreakers.id, breaker.id)).run();
      tx.insert(signals).values({
        id: crypto.randomUUID(),
        portfolioId: DEFAULT_PORTFOLIO_ID,
        assetBucket: holding.assetBucket,
        fingerprint: `THESIS_BREACH|${breaker.id}|${event.id}`,
        severity: "WARNING",
        signalType: "THESIS_BREACH",
        oldState: null,
        newState: null,
        summary: `${holding.name}：触发失效条件「${breaker.description}」——暂停新增，写完复核后解除`,
        isDuplicate: false,
        createdAt: timestamp,
      }).run();
    }
    if (payload.kind === "REVIEW") {
      const wasTriggered = breaker.status === "TRIGGERED";
      tx.update(thesisBreakers).set({ status: "ACTIVE", lastReviewedAt: timestamp, updatedAt: timestamp }).where(eq(thesisBreakers.id, breaker.id)).run();
      if (wasTriggered) {
        tx.insert(signals).values({
          id: crypto.randomUUID(),
          portfolioId: DEFAULT_PORTFOLIO_ID,
          assetBucket: holding.assetBucket,
          fingerprint: `THESIS_REVIEWED|${breaker.id}|${event.id}`,
          severity: "INFO",
          signalType: "THESIS_REVIEWED",
          oldState: null,
          newState: null,
          summary: `${holding.name}：失效条件「${breaker.description}」已复核，解除暂停`,
          isDuplicate: false,
          createdAt: timestamp,
        }).run();
      }
    }
  });
  return { event, view: (await getThesisView(holdingId, shanghaiDate(now))) as ThesisView };
}

export interface ThesisSummary {
  status: ThesisStatus;
  reviewDue: boolean;
  /** 已触发、等待复核的失效条件 */
  triggered: string[];
}

/** 持仓页用：每个写了投资逻辑的持仓的状态摘要（没写的持仓不在 Map 里）。 */
export async function listThesisSummaries(today = shanghaiDate()): Promise<Map<string, ThesisSummary>> {
  const db = getDatabase();
  const theses = db.select().from(holdingTheses).where(eq(holdingTheses.portfolioId, DEFAULT_PORTFOLIO_ID)).all();
  if (theses.length === 0) return new Map();
  const ids = theses.map((thesis) => thesis.id);
  const breakers = db.select().from(thesisBreakers).where(inArray(thesisBreakers.thesisId, ids)).orderBy(asc(thesisBreakers.position)).all();
  const reviews = db.select().from(thesisEvents).where(and(inArray(thesisEvents.thesisId, ids), eq(thesisEvents.kind, "REVIEW"))).all();
  return new Map(theses.map((thesis) => {
    const own = breakers.filter((breaker) => breaker.thesisId === thesis.id);
    const reviewedOn = lastReviewOn(reviews.filter((event) => event.thesisId === thesis.id));
    return [thesis.holdingId, {
      status: thesisStatus({ hasThesis: true, breakers: own }),
      reviewDue: reviewDue({ lastReviewOn: reviewedOn, thesisCreatedAt: thesis.createdAt, today }),
      triggered: own.filter((breaker) => breaker.status === "TRIGGERED").map((breaker) => breaker.description),
    }];
  }));
}
