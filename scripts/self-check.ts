import "./load-env";
import fs from "node:fs";
import path from "node:path";

/**
 * `pnpm self-check`：在本机用真实接口核对数据与计算（只读，不写数据库）。
 * - Tushare 能不能拉到行情，和库里存的是否一致；
 * - 官方指数估值的历史够不够 5 年、评分实际用的是哪个口径；
 * - 财报汇总是否新鲜；
 * - 用当前代码重算各资产的分数，和库里最新一次评分是否一致；
 * - DeepSeek 搜索、读网页、模型调用是否正常。
 * 任何一项失败退出码为 1。不打印任何 Key。
 */
type Level = "OK" | "WARN" | "FAIL";
const results: Array<{ level: Level; title: string }> = [];
const ICONS: Record<Level, string> = { OK: "✓", WARN: "⚠", FAIL: "✗" };

function report(level: Level, title: string, detail: string) {
  results.push({ level, title });
  console.log(`${ICONS[level]} ${title}：${detail}`);
}

function yearsBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365.25 * 86_400_000);
}

function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

const BUCKET_NAMES = { GOLD: "黄金", VALUE_DIVIDEND: "红利与价值", TECH_GROWTH: "科技与成长", BROAD_EQUITY: "宽基权益" } as const;
type Bucket = keyof typeof BUCKET_NAMES;
const EQUITY_BUCKETS: Bucket[] = ["VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"];
const GROWTH_KEY: Record<string, string> = { VALUE_DIVIDEND: "EARNINGS_GROWTH", TECH_GROWTH: "EARNINGS_GROWTH", BROAD_EQUITY: "INDEX_EARNINGS_GROWTH" };
const QUARTER_GROWTH_KEY: Record<string, string> = { VALUE_DIVIDEND: "EARNINGS_GROWTH_Q", TECH_GROWTH: "EARNINGS_GROWTH_Q", BROAD_EQUITY: "INDEX_EARNINGS_GROWTH_Q" };

async function main() {
  const databaseFile = path.resolve(process.env.DATABASE_URL ?? "./data/hengcang.db");
  if (!fs.existsSync(databaseFile)) {
    report("FAIL", "数据库", `找不到 ${databaseFile}；先运行 pnpm db:migrate、pnpm db:seed、pnpm data:refresh`);
    return;
  }
  const { rawDatabase } = await import("../src/db/client");
  const { shanghaiDate } = await import("../src/lib/shanghai");
  const database = rawDatabase();
  const sqlite = {
    all: (sql: string, ...params: unknown[]) => database.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    get: (sql: string, ...params: unknown[]) => database.prepare(sql).get(...params) as Record<string, unknown> | undefined,
  };
  const today = shanghaiDate();
  report("OK", "数据库", databaseFile);
  report(process.env.TUSHARE_TOKEN ? "OK" : "FAIL", "Tushare Token", process.env.TUSHARE_TOKEN ? "已配置" : "没有配置（.env.local 里的 TUSHARE_TOKEN）");
  report(process.env.DEEPSEEK_API_KEY ? "OK" : "WARN", "DeepSeek Key", process.env.DEEPSEEK_API_KEY ? "已配置" : "没有配置，AI 新闻监控不会运行");

  // 1. 行情：Tushare 现拉近 20 天，和库里同一天的收盘价对比
  if (process.env.TUSHARE_TOKEN) {
    const { TushareProvider } = await import("../src/providers/tushare");
    const { getTushareScoreProxies } = await import("../src/providers/tushare/proxies");
    const provider = new TushareProvider();
    for (const proxy of getTushareScoreProxies()) {
      const fetched = await provider.getPriceSeries({ symbol: proxy.symbol, instrumentKind: proxy.instrumentKind, range: { start: daysBefore(today, 30), end: today } });
      const name = `${BUCKET_NAMES[proxy.bucket as Bucket]}行情（${proxy.label}）`;
      if (!fetched.ok) {
        report("FAIL", name, `Tushare 拉取失败：${fetched.error.message}`);
        continue;
      }
      const stored = new Map(sqlite.all("select as_of, value from metric_observations where subject_id = ? and metric_key = 'PRICE_CLOSE' and provider = 'tushare' and as_of >= ?", proxy.bucket, daysBefore(today, 30)).map((row) => [String(row.as_of), Number(row.value)]));
      const overlaps = fetched.data.filter((point) => stored.has(point.asOf));
      const maxDiff = overlaps.reduce((max, point) => Math.max(max, Math.abs(Number(point.close) / stored.get(point.asOf)! - 1)), 0);
      const latestFetched = fetched.data.map((point) => point.asOf).sort().at(-1) ?? "无";
      const latestStored = [...stored.keys()].sort().at(-1) ?? "无";
      if (overlaps.length === 0) report("WARN", name, `库里近 30 天没有行情（Tushare 最新 ${latestFetched}）；跑一次 pnpm data:refresh`);
      else if (maxDiff > 1e-6) report("WARN", name, `${overlaps.length} 天里最大差 ${(maxDiff * 100).toFixed(4)}%（Tushare 修订过？刷新一次会更新）`);
      else report(latestStored < latestFetched ? "WARN" : "OK", name, `${overlaps.length} 天收盘价与 Tushare 完全一致；库里最新 ${latestStored}，Tushare 最新 ${latestFetched}`);
    }
  }

  // 2. 估值口径：官方指数估值的历史够不够 5 年，评分用的是哪个来源
  const { SqliteMetricSeriesRepository } = await import("../src/metrics/observation-repository");
  const { SCORING_PROVIDER_POLICY } = await import("../src/server/scoring-refresh-service");
  const repository = new SqliteMetricSeriesRepository(SCORING_PROVIDER_POLICY);
  for (const bucket of EQUITY_BUCKETS) {
    const official = sqlite.get("select count(*) n, min(as_of) first, max(as_of) last from metric_observations where subject_id = ? and metric_key = 'PE_TTM' and provider = 'tushare'", bucket) ?? {};
    const series = await repository.resolveSeries({ subjectId: bucket, metricKey: "PE_TTM", asOf: today });
    const officialYears = official.first ? yearsBetween(String(official.first), today) : 0;
    const latestAggregate = sqlite.get("select value, as_of from metric_observations where subject_id = ? and metric_key = 'PE_TTM' and provider = 'tushare-index-aggregate' order by as_of desc limit 1", bucket);
    const latestOfficial = sqlite.get("select value, as_of from metric_observations where subject_id = ? and metric_key = 'PE_TTM' and provider = 'tushare' order by as_of desc limit 1", bucket);
    const comparison = latestAggregate && latestOfficial
      ? `；最新官方 PE ${Number(latestOfficial.value).toFixed(2)}（${latestOfficial.as_of}），成分股汇总 ${Number(latestAggregate.value).toFixed(2)}（${latestAggregate.as_of}）`
      : "";
    const name = `${BUCKET_NAMES[bucket]}估值口径`;
    if (series.source === "tushare") report("OK", name, `评分用官方指数估值，历史 ${officialYears.toFixed(1)} 年${comparison}`);
    else report("WARN", name, `评分用 ${series.source}（官方估值只有 ${officialYears.toFixed(1)} 年，跑一次 FULL_BACKFILL=true pnpm data:refresh 后换成官方）${comparison}`);
  }

  // 3. 财报汇总是否新鲜
  const { inReportingSeason } = await import("../src/server/automatic-data-refresh-service");
  const staleDays = inReportingSeason(today) ? 10 : 120;
  for (const bucket of EQUITY_BUCKETS) {
    const row = sqlite.get("select as_of, value, metadata_json from metric_observations where subject_id = ? and metric_key = ? and provider = 'tushare-index-aggregate' order by as_of desc limit 1", bucket, GROWTH_KEY[bucket]);
    const name = `${BUCKET_NAMES[bucket]}财报汇总`;
    if (!row) {
      report("FAIL", name, "没有财报汇总；跑一次 FULL_BACKFILL=true pnpm data:refresh");
      continue;
    }
    const meta = JSON.parse(String(row.metadata_json ?? "{}")) as { reportPeriod?: string; reportPeriodShare?: number; constituentCoverage?: number };
    const ageDays = Math.round(yearsBetween(String(row.as_of), today) * 365.25);
    const quarter = sqlite.get("select value from metric_observations where subject_id = ? and metric_key = ? and provider = 'tushare-index-aggregate' and as_of = ?", bucket, QUARTER_GROWTH_KEY[bucket], row.as_of);
    const detail = `最新 ${row.as_of}：增速中位数 累计 ${Number(row.value).toFixed(2)}% / 单季 ${quarter ? `${Number(quarter.value).toFixed(2)}%` : "无（需全量回填）"}，以 ${meta.reportPeriod ?? "未知"} 为主（占 ${meta.reportPeriodShare !== undefined ? (meta.reportPeriodShare * 100).toFixed(0) + "%" : "未记录，需全量回填"}），覆盖 ${meta.constituentCoverage !== undefined ? (meta.constituentCoverage * 100).toFixed(0) + "%" : "未知"}`;
    report(ageDays > staleDays ? "WARN" : meta.reportPeriodShare === undefined ? "WARN" : "OK", name, ageDays > staleDays ? `${detail}；已 ${ageDays} 天没更新` : detail);
  }
  const fina = sqlite.get("select last_success_at, last_error_message from data_source_status where provider = 'tushare-fina'");
  report(fina?.last_success_at ? "OK" : "WARN", "财报刷新", fina?.last_success_at ? `上次成功 ${fina.last_success_at}${fina.last_error_message ? `；上次警告：${String(fina.last_error_message).slice(0, 120)}` : ""}` : "还没有成功过");

  // 4. 用当前代码重算最新一次评分，和库里的对比（只比分数；状态还取决于仓位）
  const { ScoreInputBuilder } = await import("../src/domain/scoring/input-builder");
  const { calculateAssetScore, DEFAULT_SCORING_CONFIG, formatHealthPoint } = await import("../src/domain/scoring");
  const { STATE_LABELS } = await import("../src/lib/presentation");
  type HealthCheckPoint = Parameters<typeof formatHealthPoint>[0];
  for (const bucket of Object.keys(BUCKET_NAMES) as Bucket[]) {
    const snapshot = sqlite.get("select as_of, cheapness_score, trend_score, opportunity_score, recommendation_state, confidence, components_json from score_snapshots where asset_bucket = ? order by as_of desc limit 1", bucket);
    const name = `${BUCKET_NAMES[bucket]}评分复算`;
    if (!snapshot) {
      report("FAIL", name, "库里没有评分");
      continue;
    }
    const asOf = String(snapshot.as_of);
    const input = await new ScoreInputBuilder(new SqliteMetricSeriesRepository(SCORING_PROVIDER_POLICY)).build(bucket, asOf);
    const result = calculateAssetScore(input);
    const modelVersion = (JSON.parse(String(snapshot.components_json)) as { modelVersion?: number }).modelVersion;
    const same = result.cheapnessScore === snapshot.cheapness_score && result.trendScore === snapshot.trend_score && result.opportunityScore === snapshot.opportunity_score;
    const stored = JSON.parse(String(snapshot.components_json)) as { fundamentalHealth?: { status?: string; checks?: Array<{ label: string; latest: HealthCheckPoint | null; previous: HealthCheckPoint | null }> } };
    const health = stored.fundamentalHealth;
    const checks = (health?.checks ?? []).map((check) => `${check.label} ${check.latest ? formatHealthPoint(check.latest) : "—"}；上一期 ${check.previous ? formatHealthPoint(check.previous) : "—"}`).join("；");
    if (same) {
      report("OK", name, `${asOf}：便宜程度 ${result.cheapnessScore}，趋势 ${result.trendScore}，配置吸引力 ${result.opportunityScore}，与库里一致（第 ${DEFAULT_SCORING_CONFIG.version} 版算法）`);
    } else {
      report("WARN", name, `${asOf}：库里 便宜程度 ${snapshot.cheapness_score} / 趋势 ${snapshot.trend_score} / 配置吸引力 ${snapshot.opportunity_score}（第 ${modelVersion ?? "?"} 版算法），按当前代码重算是 ${result.cheapnessScore} / ${result.trendScore} / ${result.opportunityScore}；刷新一次（pnpm data:refresh）就会更新`);
    }
    console.log(`    状态 ${STATE_LABELS[String(snapshot.recommendation_state) as keyof typeof STATE_LABELS] ?? snapshot.recommendation_state}（可信度 ${snapshot.confidence}）；体检 ${health?.status ?? "—"}${checks ? `：${checks}` : ""}`);
  }

  // 5. DeepSeek：搜索、读网页、模型
  const { DeepSeekClient, DeepSeekError } = await import("../src/providers/deepseek");
  const client = DeepSeekClient.fromEnv();
  if (client) {
    const describe = (error: unknown) => (error instanceof DeepSeekError ? `HTTP ${error.status}：${error.message}` : String(error));
    let firstUrl: string | undefined;
    try {
      const started = Date.now();
      const hits = await client.search("沪深300 指数 最新 消息", { count: 5 });
      firstUrl = hits[0]?.url;
      report(hits.length > 0 ? "OK" : "WARN", "DeepSeek 新闻搜索", `${hits.length} 条，${((Date.now() - started) / 1000).toFixed(1)} 秒${hits[0] ? `；第一条：${hits[0].title.slice(0, 40)}` : ""}`);
    } catch (error) {
      report("FAIL", "DeepSeek 新闻搜索", describe(error));
    }
    if (firstUrl) {
      try {
        const started = Date.now();
        const page = await client.fetchPage(firstUrl);
        report(page.content.length > 200 ? "OK" : "WARN", "DeepSeek 读网页", `正文 ${page.content.length} 字，${((Date.now() - started) / 1000).toFixed(1)} 秒`);
      } catch (error) {
        report("WARN", "DeepSeek 读网页", `${describe(error)}（个别网站读不到正文是正常的）`);
      }
    }
    try {
      const started = Date.now();
      const reply = await client.chatJson([
        { role: "system", content: "只输出 JSON。" },
        { role: "user", content: "请回复 {\"ok\": true}" },
      ]);
      const okReply = Boolean(reply && typeof reply === "object" && (reply as { ok?: unknown }).ok === true);
      report(okReply ? "OK" : "WARN", "DeepSeek 模型", `${okReply ? "正常" : `回复格式不对：${JSON.stringify(reply).slice(0, 80)}`}，${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    } catch (error) {
      report("FAIL", "DeepSeek 模型", describe(error));
    }
  }
}

await main();
const failed = results.filter((item) => item.level === "FAIL").length;
const warned = results.filter((item) => item.level === "WARN").length;
console.log(`\n共 ${results.length} 项：${results.length - failed - warned} 项正常，${warned} 项需要注意，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
