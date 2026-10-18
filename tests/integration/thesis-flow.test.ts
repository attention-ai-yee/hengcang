import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { holdings, holdingTheses, signals } from "@/db/schema";
import { shanghaiDate } from "@/lib/shanghai";
import { createHolding, deleteHolding } from "@/server/portfolio-service";
import { listThesisSummaries } from "@/server/thesis-service";
import { GET, PUT } from "../../app/api/portfolio/holdings/[id]/thesis/route";
import { POST } from "../../app/api/portfolio/holdings/[id]/thesis/events/route";

/**
 * 持仓级投资逻辑纵切（docs/hengcang_v2_allocation_fundamentals_thesis.md §4）：
 * 写逻辑 → 消息触发失效条件（暂停新增 + WARNING 信号）→ 触发的条件不能删改 → 写复核解除（INFO 信号）。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-thesis-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
let holdingId = "";

type Json = { data?: Record<string, unknown> & { view?: Record<string, unknown> }; error?: { code: string; fields?: Record<string, string[]> } };

function context(id = holdingId) {
  return { params: Promise.resolve({ id }) };
}

async function call(response: Promise<Response>) {
  const result = await response;
  return { status: result.status, json: (await result.json()) as Json };
}

function put(body: unknown, id = holdingId) {
  return call(PUT(new Request("http://localhost/api", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), context(id)));
}

function postEvent(body: unknown, id = holdingId) {
  return call(POST(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), context(id)));
}

function getView(id = holdingId) {
  return call(GET(new Request("http://localhost/api"), context(id)));
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
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("投资逻辑与失效条件", () => {
  it("没写逻辑时：状态 NO_THESIS，单一个股提示必须写；记录消息被拒绝", async () => {
    const { status, json } = await getView();
    expect(status).toBe(200);
    expect(json.data?.status).toBe("NO_THESIS");
    expect(json.data?.needsThesis).toBe(true);
    const event = await postEvent({ kind: "NEWS", occurredOn: shanghaiDate(), summary: "消息" });
    expect(event.status).toBe(409);
    expect(event.json.error?.code).toBe("THESIS_NOT_FOUND");
  });

  it("写下逻辑和两条失效条件", async () => {
    const { status, json } = await put({
      thesis: "锂电扩产周期带动设备订单，龙头份额稳定。",
      breakers: [{ description: "锂电设备行业资本开支同比下滑超过 30%" }, { description: "最大客户订单明显缩减" }],
    });
    expect(status).toBe(200);
    expect(json.data?.status).toBe("INTACT");
    const breakers = json.data?.breakers as Array<{ description: string; status: string }>;
    // 同一次保存的条目 createdAt 相同：顺序必须来自 position，而不是随机 id
    expect(breakers.map((breaker) => breaker.description)).toEqual(["锂电设备行业资本开支同比下滑超过 30%", "最大客户订单明显缩减"]);
    expect(breakers.map((breaker) => breaker.status)).toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("消息对应失效条件 → 触发、暂停新增，并写 WARNING 信号", async () => {
    const view = (await getView()).json.data as { breakers: Array<{ id: string; description: string }> };
    const customer = view.breakers.find((breaker) => breaker.description.includes("客户"));
    const { status, json } = await postEvent({
      kind: "NEWS",
      occurredOn: shanghaiDate(),
      summary: "公告：最大客户下调明年设备采购计划",
      sourceUrl: "https://example.com/notice",
      breakerId: customer?.id,
    });
    expect(status).toBe(200);
    expect(json.data?.view?.status).toBe("BREACHED");
    const warnings = getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_BREACH")).all();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("WARNING");
    expect(warnings[0].assetBucket).toBe("TECH_GROWTH");
    expect(warnings[0].summary).toContain("先导智能");
    expect((await listThesisSummaries()).get(holdingId)).toMatchObject({ status: "BREACHED", triggered: ["最大客户订单明显缩减"] });
  });

  it("已触发的条件不能删除或改写；未触发的照常可改、可加", async () => {
    const view = (await getView()).json.data as { thesis: { thesis: string }; breakers: Array<{ id: string; description: string; status: string }> };
    const [capex, customer] = view.breakers;
    const removal = await put({ thesis: view.thesis.thesis, breakers: [{ id: capex.id, description: capex.description }] });
    expect(removal.status).toBe(409);
    expect(removal.json.error?.code).toBe("BREAKER_TRIGGERED");
    const rewrite = await put({ thesis: view.thesis.thesis, breakers: [{ id: capex.id, description: capex.description }, { id: customer.id, description: "客户订单略有下降" }] });
    expect(rewrite.status).toBe(409);
    const ok = await put({
      thesis: view.thesis.thesis,
      breakers: [{ id: capex.id, description: "锂电设备行业资本开支同比下滑超过 25%" }, { id: customer.id, description: customer.description }, { description: "毛利率连续两个季度下滑" }],
    });
    expect(ok.status).toBe(200);
    expect((ok.json.data?.breakers as Array<{ description: string }>).map((breaker) => breaker.description))
      .toEqual(["锂电设备行业资本开支同比下滑超过 25%", "最大客户订单明显缩减", "毛利率连续两个季度下滑"]);
    expect(ok.json.data?.status).toBe("BREACHED");
  });

  it("校验：未来日期、非 http(s) 来源、不属于这份逻辑的条件 id 都被拒绝", async () => {
    expect((await postEvent({ kind: "NEWS", occurredOn: "2099-01-01", summary: "x" })).status).toBe(422);
    expect((await postEvent({ kind: "NEWS", occurredOn: shanghaiDate(), summary: "x", sourceUrl: "javascript:alert(1)" })).status).toBe(422);
    const unknown = await postEvent({ kind: "NEWS", occurredOn: shanghaiDate(), summary: "x", breakerId: "not-a-breaker" });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error?.code).toBe("UNKNOWN_BREAKER");
  });

  it("写复核解除触发：回到 INTACT，写 INFO 信号，记录复核日期", async () => {
    const view = (await getView()).json.data as { breakers: Array<{ id: string; status: string }> };
    const triggered = view.breakers.find((breaker) => breaker.status === "TRIGGERED");
    const { status, json } = await postEvent({ kind: "REVIEW", occurredOn: shanghaiDate(), summary: "订单下调幅度有限，在手订单仍覆盖一年，逻辑未破坏", breakerId: triggered?.id });
    expect(status).toBe(200);
    const after = json.data?.view as { status: string; lastReviewOn: string | null; reviewDue: boolean; events: Array<{ kind: string }> };
    expect(after.status).toBe("INTACT");
    expect(after.lastReviewOn).toBe(shanghaiDate());
    expect(after.reviewDue).toBe(false);
    expect(after.events.map((event) => event.kind)).toEqual(["REVIEW", "NEWS"]);
    const infos = getDatabase().select().from(signals).where(eq(signals.signalType, "THESIS_REVIEWED")).all();
    expect(infos).toHaveLength(1);
    expect(infos[0].severity).toBe("INFO");
  });

  it("删除持仓时投资逻辑一并删除", async () => {
    expect(await deleteHolding(holdingId)).toBe(true);
    expect(getDatabase().select().from(holdingTheses).where(eq(holdingTheses.holdingId, holdingId)).all()).toHaveLength(0);
    expect(getDatabase().select().from(holdings).where(eq(holdings.id, holdingId)).all()).toHaveLength(0);
    expect((await getView()).status).toBe(404);
  });
});
