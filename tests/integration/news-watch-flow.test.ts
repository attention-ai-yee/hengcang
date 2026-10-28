import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { dataSourceStatus, holdingTheses, newsItems, signals, thesisBreakers, thesisEvents } from "@/db/schema";
import { DeepSeekError, type ChatMessage, type DeepSeekSearchResult, type NewsClient } from "@/providers/deepseek";
import { createHolding, deleteHolding } from "@/server/portfolio-service";
import {
  confirmNewsItem,
  dismissNewsItem,
  draftThesis,
  listNewsItems,
  scanNews,
  NEWS_STATUS_PROVIDER,
  NewsWatchError,
} from "@/server/news-watch-service";
import { dismissAiTrigger, getThesisView, listThesisSummaries, recordThesisEvent, saveThesis, ThesisError } from "@/server/thesis-service";

/**
 * AI 新闻监控纵切（docs/hengcang_v2_allocation_fundamentals_thesis.md §7），用假的 DeepSeek：
 * 搜索 → 初筛 → 带正文复核 → 只有证据确凿的自动触发；其余等你确认 / 忽略；误判一键撤销（不算复核）。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-news-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const NOW = new Date("2026-10-19T02:00:00Z"); // 上海 10-19 10:00
const later = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60 * 1000);

function hit(overrides: Partial<DeepSeekSearchResult> & Pick<DeepSeekSearchResult, "title" | "url">): DeepSeekSearchResult {
  return { snippet: "", summary: "", content: "", siteName: "示例财经", date: "2026-10-18T01:00:00Z", authority: 3, rerankScore: 1, ...overrides };
}

const CATL = hit({
  title: "宁德时代公告下调明年设备采购计划",
  url: "https://news.example.com/catl?utm_source=feed",
  summary: "宁德时代公告下调设备采购计划",
  content: "宁德时代10月15日公告：公司下调2027年设备采购计划，对先导智能的订单同比减少40%。",
  date: "2026-10-17T03:00:00Z",
  rerankScore: 2.5,
});
const FORECAST = hit({ title: "锂电设备资本开支或将放缓", url: "https://news.example.com/capex-view", summary: "券商观点", siteName: "示例证券", authority: 2, rerankScore: 2.0 });
const RUMOR = hit({
  title: "小站爆料先导智能毛利率连降",
  url: "https://blog.example.com/rumor",
  content: "据统计，先导智能毛利率已连续两个季度下滑，三季度降至31%。",
  siteName: "某博客",
  authority: 1,
  rerankScore: 1.9,
});
const Q3 = hit({ title: "先导智能发布三季报", url: "https://news.example.com/q3", content: "三季度营收同比增长5%。", date: "2026-10-16T08:00:00Z", authority: 4, rerankScore: 1.8 });
const AD = hit({ title: "十大牛股盘点", url: "https://ads.example.com/top10", date: null, authority: 0, rerankScore: 0.5 });
const OLD = hit({ title: "去年的行业数据", url: "https://news.example.com/old", date: "2026-08-20T00:00:00Z", authority: 4, rerankScore: 3 });
const CATL_COPY = { ...CATL, url: "https://news.example.com/catl?utm_medium=app", rerankScore: 2.4 };
/** 同一件事换了说法的转载（标题不同，标题去重拦不住，要靠「复核 / 撤销之后」的规则） */
const REWORDED_1 = "宁德时代削减明年设备采购，先导智能订单受影响";
const REWORDED_2 = "宁德时代下调设备采购，锂电设备商承压";

class FakeNewsClient implements NewsClient {
  readonly model = "fake-model";
  readonly searches: string[] = [];
  readonly fetches: string[] = [];
  readonly prompts: string[] = [];
  queryCalls = 0;

  constructor(private readonly hits: DeepSeekSearchResult[], private readonly failSearch?: DeepSeekError) {}

  async search(query: string) {
    this.searches.push(query);
    if (this.failSearch) throw this.failSearch;
    return this.hits.map((item) => ({ ...item }));
  }

  async fetchPage(url: string) {
    this.fetches.push(url);
    return { title: "", content: url === FORECAST.url ? "分析师预计明年锂电设备资本开支可能同比下滑三成。" : "" };
  }

  async chatJson(messages: ChatMessage[]): Promise<unknown> {
    const prompt = messages.map((message) => message.content).join("\n");
    this.prompts.push(prompt);
    if (prompt.includes("新闻搜索词")) {
      this.queryCalls += 1;
      return { queries: ["先导智能 公告", "宁德时代 设备采购"] };
    }
    if (prompt.includes("候选新闻")) {
      const screening: Record<string, { verdict: string; breaker?: string }> = {
        [CATL.title]: { verdict: "POSSIBLE", breaker: "B2" },
        [REWORDED_1]: { verdict: "POSSIBLE", breaker: "B2" },
        [REWORDED_2]: { verdict: "POSSIBLE", breaker: "B2" },
        [FORECAST.title]: { verdict: "POSSIBLE", breaker: "B1" },
        [RUMOR.title]: { verdict: "POSSIBLE", breaker: "B3" },
        [Q3.title]: { verdict: "RELATED" },
      };
      return {
        items: [...prompt.matchAll(/^\[(\d+)\] 标题：(.+?) \|/gm)].map((match) => ({
          index: Number(match[1]),
          verdict: screening[match[2]]?.verdict ?? "IRRELEVANT",
          breakerId: screening[match[2]]?.breaker ?? null,
          summary: `${match[2]}（摘要）`,
        })),
      };
    }
    if (prompt.includes("要核对的失效条件")) {
      const title = /^文章：(.+?)（/m.exec(prompt)?.[1];
      if (title === CATL.title || title === REWORDED_1 || title === REWORDED_2) {
        return { triggered: true, confidence: "HIGH", occurredOn: "2026-10-15", evidence: "公司下调2027年设备采购计划，对先导智能的订单同比减少40%", summary: "宁德时代下调2027年设备采购计划，对先导智能订单同比减少40%" };
      }
      if (title === FORECAST.title) {
        return { triggered: true, confidence: "MEDIUM", occurredOn: null, evidence: "分析师预计明年锂电设备资本开支可能同比下滑三成", summary: "券商预计明年锂电设备资本开支下滑" };
      }
      if (title === RUMOR.title) {
        return { triggered: true, confidence: "HIGH", occurredOn: "2026-10-18", evidence: "先导智能毛利率已连续两个季度下滑", summary: "博客称先导智能毛利率连续两个季度下滑" };
      }
      return { triggered: false, confidence: "LOW" };
    }
    if (prompt.includes("请起草")) return { thesis: " 草稿逻辑 ", breakers: ["条件一", "条件二", "条件三"] };
    throw new Error(`没有预设的提示词：${prompt.slice(0, 40)}`);
  }
}

let holdingId = "";
let thesisId = "";
let capexId = "";
let customerId = "";
let marginId = "";
const fake = new FakeNewsClient([CATL, FORECAST, RUMOR, Q3, AD, OLD, CATL_COPY]);

function itemByUrl(url: string) {
  const row = getDatabase().select().from(newsItems).where(eq(newsItems.url, url)).get();
  if (!row) throw new Error(`没有找到 ${url}`);
  return row;
}

function breaker(id: string) {
  return getDatabase().select().from(thesisBreakers).where(eq(thesisBreakers.id, id)).get();
}

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabase;
  migrate(getDatabase(), { migrationsFolder: path.resolve("drizzle") });
  const holding = await createHolding({
    name: "先导智能", symbol: "300450", instrumentType: "STOCK", assetBucket: "TECH_GROWTH", region: "CN",
    theme: "锂电设备", marketValueMinor: "5000000", currency: "CNY", isSingleStock: true, isThematicEtf: false,
    isApproximate: false, needsBreakdown: false, asOf: "2026-10-18",
  });
  holdingId = holding.id;
  const view = await saveThesis(holdingId, {
    thesis: "锂电扩产周期带动设备订单，龙头份额稳定。",
    breakers: [{ description: "锂电设备行业资本开支同比下滑超过 30%" }, { description: "最大客户订单明显缩减" }, { description: "毛利率连续两个季度下滑" }],
  }, new Date("2026-10-01T02:00:00Z"));
  thesisId = view.thesis?.id ?? "";
  [capexId, customerId, marginId] = view.breakers.map((item) => item.id);
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("AI 新闻监控", () => {
  it("没配置 DEEPSEEK_API_KEY：返回 NOT_CONFIGURED 并记在数据状态里", async () => {
    expect((await scanNews({ client: null, now: NOW })).status).toBe("NOT_CONFIGURED");
    const status = getDatabase().select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, NEWS_STATUS_PROVIDER)).get();
    expect(status).toMatchObject({ status: "NOT_CONFIGURED", enabled: false });
  });

  it("扫描：证据确凿的自动触发；预测和低权威来源只标「可能触发」；旧闻和重复链接被过滤", async () => {
    const report = await scanNews({ client: fake, now: NOW });
    expect(report).toMatchObject({ status: "READY", scanned: 1, skipped: 0, newItems: 5, triggered: 1, possible: 2, warnings: [] });

    // 搜索词由模型生成并缓存；每个搜索词都只搜最近 30 天
    expect(fake.queryCalls).toBe(1);
    expect(fake.searches).toEqual(["先导智能 公告 after:2026-09-19", "宁德时代 设备采购 after:2026-09-19"]);
    // 搜索结果没带正文的才去抓取
    expect(fake.fetches).toEqual([FORECAST.url]);

    expect(itemByUrl("https://news.example.com/catl")).toMatchObject({ verdict: "TRIGGER", breakerId: customerId, authority: 3 });
    expect(itemByUrl(FORECAST.url)).toMatchObject({ verdict: "POSSIBLE", breakerId: capexId, status: "OPEN" });
    expect(itemByUrl(RUMOR.url)).toMatchObject({ verdict: "POSSIBLE", breakerId: marginId, status: "OPEN" });
    expect(itemByUrl(Q3.url)).toMatchObject({ verdict: "RELATED", breakerId: null });
    expect(itemByUrl(AD.url)).toMatchObject({ verdict: "IRRELEVANT" });
    expect(getDatabase().select().from(newsItems).where(eq(newsItems.url, OLD.url)).all()).toHaveLength(0);
    expect(listNewsItems(thesisId).map((item) => item.verdict).sort()).toEqual(["POSSIBLE", "POSSIBLE", "RELATED", "TRIGGER"]);
    // 待确认的永远全部列出、排在最前，即使列表上限只有 1 条
    const short = listNewsItems(thesisId, 1);
    expect(short.filter((item) => item.verdict === "POSSIBLE" && item.status === "OPEN")).toHaveLength(2);
    expect(short.slice(0, 2).map((item) => item.verdict)).toEqual(["POSSIBLE", "POSSIBLE"]);

    // 自动触发走和手工记录同一条路径：条件 TRIGGERED、AI 事件、WARNING 信号
    const customer = breaker(customerId);
    expect(customer?.status).toBe("TRIGGERED");
    const event = getDatabase().select().from(thesisEvents).where(eq(thesisEvents.id, customer?.triggeredByEventId ?? "")).get();
    expect(event).toMatchObject({ kind: "NEWS", origin: "AI", occurredOn: "2026-10-15", sourceUrl: "https://news.example.com/catl", breakerId: customerId });
    expect(event?.summary).toContain("原文：「公司下调2027年设备采购计划");
    expect(itemByUrl("https://news.example.com/catl").eventId).toBe(event?.id);
    const warnings = getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_BREACH")).all();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].summary).toContain("AI 从新闻判断");
    expect(breaker(capexId)?.status).toBe("ACTIVE");
    expect((await listThesisSummaries("2026-10-19")).get(holdingId)).toMatchObject({ status: "BREACHED", pendingNews: 2 });

    const thesis = getDatabase().select().from(holdingTheses).where(eq(holdingTheses.id, thesisId)).get();
    expect(JSON.parse(thesis?.newsQueriesJson ?? "[]")).toEqual(["先导智能 公告", "宁德时代 设备采购"]);
    expect(thesis?.newsQueriesBasis).toBeTruthy();
    expect(thesis?.newsScannedAt).toBe(NOW.toISOString());
    expect(getDatabase().select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, NEWS_STATUS_PROVIDER)).get())
      .toMatchObject({ status: "READY", enabled: true, lastSuccessAt: NOW.toISOString() });
  });

  it("发给模型的只有名称、代码、逻辑和条件：没有金额，条件只用 B1/B2 编号", () => {
    for (const prompt of fake.prompts) {
      expect(prompt).not.toContain("5000000");
      expect(prompt).not.toContain(capexId);
      expect(prompt).not.toContain(customerId);
      expect(prompt).not.toContain(marginId);
    }
    const screening = fake.prompts.find((prompt) => prompt.includes("候选新闻")) ?? "";
    // 已触发的条件不再交给模型（这里两条都还是 ACTIVE）
    expect(screening).toContain("- B1：锂电设备行业资本开支同比下滑超过 30%");
    expect(screening).toContain("- B2：最大客户订单明显缩减");
  });

  it("每天一次：20 小时内不重复扫描；强制扫描时看过的链接不再判断、不重复触发", async () => {
    const searches = fake.searches.length;
    const prompts = fake.prompts.length;
    const events = getDatabase().select().from(thesisEvents).all().length;
    expect(await scanNews({ client: fake, now: later(1) })).toMatchObject({ status: "IDLE", scanned: 0, skipped: 1 });
    expect(fake.searches).toHaveLength(searches);
    expect(await scanNews({ client: fake, now: later(2), force: true })).toMatchObject({ status: "READY", scanned: 1, newItems: 0, triggered: 0 });
    expect(fake.searches).toHaveLength(searches + 2);
    expect(fake.prompts).toHaveLength(prompts);
    expect(getDatabase().select().from(thesisEvents).all()).toHaveLength(events);
  });

  it("一键确认「可能触发」→ 触发；忽略 → 不再提醒；处理过的不能重复处理", async () => {
    await confirmNewsItem(itemByUrl(FORECAST.url).id, later(3));
    expect(breaker(capexId)?.status).toBe("TRIGGERED");
    expect(itemByUrl(FORECAST.url).status).toBe("CONFIRMED");
    expect((await listThesisSummaries("2026-10-19")).get(holdingId)?.pendingNews).toBe(1);

    await dismissNewsItem(itemByUrl(RUMOR.url).id, later(3));
    expect(itemByUrl(RUMOR.url).status).toBe("DISMISSED");
    expect((await listThesisSummaries("2026-10-19")).get(holdingId)?.pendingNews).toBe(0);

    await expect(confirmNewsItem(itemByUrl(RUMOR.url).id)).rejects.toMatchObject({ code: "NOT_PENDING", status: 409 });
    await expect(dismissNewsItem(itemByUrl(RUMOR.url).id)).rejects.toBeInstanceOf(NewsWatchError);
    await expect(confirmNewsItem("no-such-item")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("误判一键撤销：条件恢复、记「撤销误判」（不算复核）、写 INFO 信号", async () => {
    const catl = itemByUrl("https://news.example.com/catl");
    await dismissNewsItem(catl.id, later(4));
    expect(breaker(customerId)).toMatchObject({ status: "ACTIVE", triggeredByEventId: null });
    expect(itemByUrl("https://news.example.com/catl").status).toBe("DISMISSED");
    const dismissals = getDatabase().select().from(thesisEvents).where(eq(thesisEvents.kind, "DISMISS")).all();
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]).toMatchObject({ origin: "MANUAL", breakerId: customerId });
    expect(dismissals[0].summary).toContain("撤销 AI 误判");
    expect(getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_AI_DISMISSED")).all()).toHaveLength(1);
    // 撤销不是复核：季度复核时间不受影响
    expect((await getThesisView(holdingId, "2026-10-19"))?.lastReviewOn).toBeNull();
    await expect(dismissNewsItem(catl.id)).rejects.toMatchObject({ code: "NOT_PENDING" });

    // 你确认过的那条同样可以撤销
    await dismissNewsItem(itemByUrl(FORECAST.url).id, later(4));
    expect(breaker(capexId)?.status).toBe("ACTIVE");
  });

  it("撤销之后，同一条新闻换个网站转载不会再次触发（复查发现）", async () => {
    const breaches = getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_BREACH")).all().length;
    // 原标题转载：以前看过的标题直接跳过，不再判断
    const sameHeadline = { ...CATL, url: "https://mirror.example.com/catl", date: "2026-10-18T03:00:00Z" };
    // 换了说法的转载 1：发布日期早于撤销那天 → 初筛就降为相关，不再进待确认
    const repostBefore = { ...CATL, title: REWORDED_1, url: "https://other.example.com/catl-repost", date: "2026-10-18T02:00:00Z" };
    // 换了说法的转载 2：撤销后才发布，但复核出的事件日期（10-15）不晚于撤销那天 → 相关
    const repostAfter = { ...CATL, title: REWORDED_2, url: "https://third.example.com/catl-copy", date: "2026-10-20T02:00:00Z" };
    const reposts = new FakeNewsClient([sameHeadline, repostBefore, repostAfter]);
    const report = await scanNews({ client: reposts, now: later(48), force: true });
    expect(report).toMatchObject({ status: "READY", triggered: 0, possible: 0, newItems: 2 });
    expect(getDatabase().select().from(newsItems).where(eq(newsItems.url, sameHeadline.url)).all()).toHaveLength(0);
    expect(itemByUrl(repostBefore.url).verdict).toBe("RELATED");
    expect(itemByUrl(repostAfter.url).verdict).toBe("RELATED");
    expect(breaker(customerId)?.status).toBe("ACTIVE");
    expect(getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_BREACH")).all()).toHaveLength(breaches);
  });

  it("初筛返回格式不对：这一轮失败、不把文章标成看过，下一轮重试（复查发现）", async () => {
    class BrokenScreening extends FakeNewsClient {
      override async chatJson(messages: ChatMessage[]): Promise<unknown> {
        const prompt = messages.map((message) => message.content).join("\n");
        return prompt.includes("候选新闻") ? { results: [] } : super.chatJson(messages);
      }
    }
    const fresh = hit({ title: "先导智能获海外大单", url: "https://news.example.com/new-order", content: "先导智能公告获得海外订单。", rerankScore: 2 });
    const before = getDatabase().select().from(holdingTheses).where(eq(holdingTheses.id, thesisId)).get()?.newsScannedAt;
    const report = await scanNews({ client: new BrokenScreening([fresh]), now: later(50), force: true });
    expect(report.status).toBe("ERROR");
    expect(report.warnings[0]).toContain("格式不对");
    expect(getDatabase().select().from(newsItems).where(eq(newsItems.url, fresh.url)).all()).toHaveLength(0);
    expect(getDatabase().select().from(holdingTheses).where(eq(holdingTheses.id, thesisId)).get()?.newsScannedAt).toBe(before);
  });

  it("手工记录触发的条件不能一键撤销，只能写复核", async () => {
    await recordThesisEvent(holdingId, { kind: "NEWS", occurredOn: "2026-10-19", summary: "手工记录的消息", breakerId: capexId }, later(5));
    const manual = getDatabase().select().from(thesisEvents).where(eq(thesisEvents.summary, "手工记录的消息")).get();
    expect(manual?.origin).toBe("MANUAL");
    await expect(dismissAiTrigger(holdingId, capexId, "x", later(5))).rejects.toBeInstanceOf(ThesisError);
    await expect(dismissAiTrigger(holdingId, capexId, "x", later(5))).rejects.toMatchObject({ code: "NOT_AI_TRIGGER", status: 409 });
  });

  it("投资逻辑改了 → 下次扫描重新生成搜索词", async () => {
    const view = await getThesisView(holdingId);
    await saveThesis(holdingId, {
      thesis: "锂电扩产周期带动设备订单；海外客户占比提升。",
      breakers: (view?.breakers ?? []).map((item) => ({ id: item.id, description: item.description })),
    }, later(6));
    await scanNews({ client: fake, now: later(80), force: true });
    expect(fake.queryCalls).toBe(2);
  });

  it("余额不足：整轮停止，记为 ERROR，不算扫描过（下一轮重试）", async () => {
    const before = getDatabase().select().from(holdingTheses).where(eq(holdingTheses.id, thesisId)).get()?.newsScannedAt;
    const broke = new FakeNewsClient([], new DeepSeekError(402, "DeepSeek 账户余额不足，请充值（HTTP 402）"));
    const report = await scanNews({ client: broke, now: later(60), force: true });
    expect(report.status).toBe("ERROR");
    expect(report.warnings[0]).toContain("余额不足");
    expect(getDatabase().select().from(holdingTheses).where(eq(holdingTheses.id, thesisId)).get()?.newsScannedAt).toBe(before);
    expect(getDatabase().select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, NEWS_STATUS_PROVIDER)).get()?.status).toBe("ERROR");
  });

  it("AI 起草：只返回草稿；没配置或持仓不存在时报错", async () => {
    expect(await draftThesis(holdingId, fake)).toEqual({ thesis: "草稿逻辑", breakers: ["条件一", "条件二", "条件三"] });
    await expect(draftThesis(holdingId, null)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(draftThesis("no-such-holding", fake)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("删掉或改写条件时，它名下待确认的「可能触发」一并忽略，不会挂着没法处理（复查发现）", async () => {
    const pendingFor = (id: string) => ({
      id: randomUUID(), thesisId, url: `https://news.example.com/pending-${id}`, title: "待确认", siteName: null, publishedOn: "2026-10-19",
      summary: "待确认", verdict: "POSSIBLE", breakerId: id, evidence: null, authority: 3, eventId: null, status: "OPEN", foundAt: later(70).toISOString(),
    });
    getDatabase().insert(newsItems).values(pendingFor(customerId)).run();
    expect((await listThesisSummaries("2026-10-22")).get(holdingId)?.pendingNews).toBe(1);
    const view = await getThesisView(holdingId);
    await saveThesis(holdingId, {
      thesis: view?.thesis?.thesis ?? "",
      breakers: (view?.breakers ?? []).filter((item) => item.id !== customerId).map((item) => ({ id: item.id, description: item.description })),
    }, later(71));
    expect(getDatabase().select().from(newsItems).where(eq(newsItems.url, `https://news.example.com/pending-${customerId}`)).get()?.status).toBe("DISMISSED");
    expect((await listThesisSummaries("2026-10-22")).get(holdingId)?.pendingNews).toBe(0);
  });

  it("删除持仓时新闻记录一并删除", async () => {
    expect(await deleteHolding(holdingId)).toBe(true);
    expect(getDatabase().select().from(newsItems).where(eq(newsItems.thesisId, thesisId)).all()).toHaveLength(0);
  });
});
