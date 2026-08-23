# 衡仓（HengCang）
# 《评分数据补全与 Confidence 规则修订 v1.1 — API 字段级实施版》

**适用仓库**：`attention-ai-yee/hengcang`  
**目标分支**：`main`  
**文档用途**：直接交给 Codex 实施。  
**实施目标**：在现有评分模型、Provider、SQLite Observation、ScoreInputBuilder 架构上补齐可获得的数据，并让 `VALID / PARTIAL / missing` 真正影响 Confidence。  
**原则**：优先使用用户现有 Tushare 2000 积分权限；无法可靠自动获取的数据允许保持缺失或使用明确标记的代理，禁止伪造完整性。

---

## 0. 本版相对上一版的关键升级

本版已经具体到：

- 使用哪个 API；
- 输入参数；
- 请求字段；
- 输出字段到 Canonical Metric 的映射；
- 指数成分聚合公式；
- 缓存和频控；
- `availableAt` 如何写；
- `VALID / PARTIAL` 如何判定；
- 2000 积分权限不足时如何 fallback；
- 当前数据库 schema 需要修复的历史修订数据问题；
- Codex 需要修改/新增的具体文件。

---

# 1. 先修一个重要权限假设

当前仓库 `src/providers/tushare/index.ts` 对 `INDEX` 估值直接调用：

```text
index_dailybasic
```

Tushare 当前官方权限信息存在页面口径差异：

```text
接口详情页：曾显示 2000 积分
当前总权限表：index_dailybasic 标为 4000 起
```

因此程序不得把 `index_dailybasic` 视为 2000 积分必然可用。

## v1.1 规则

```text
index_dailybasic = optional fast path
```

运行时调用：

```text
成功 -> 使用官方指数 PE/PB
PERMISSION_DENIED -> 自动切换到成分股聚合 PE/PB
```

2000 积分下，核心实现必须能够完全依赖：

```text
index_daily
index_weight
daily_basic
fina_indicator
dividend
fund_share
fund_nav
sge_daily
```

这些接口完成主要评分数据。

---

# 2. Tushare 2000 积分总体约束

当前 2000+ 积分通用频次：

```text
200 requests / minute
100000 requests / API / day
```

但不同 API 可有单独限制，因此程序仍需做自己的 rate limiter。

推荐默认：

```env
TUSHARE_MAX_RPM=120
TUSHARE_CONCURRENCY=3
```

保留余量，避免多个后台任务同时运行导致触发限制。

实现：

```text
每次请求经过共享 TushareLimiter
PERMISSION_DENIED 不重试
RATE_LIMITED 指数退避
UPSTREAM_ERROR 最多重试 2 次
```

---

# 3. Canonical Metric 与 API 映射总表

| Canonical Metric | 主数据源 | API / Series | 字段 | Quality |
|---|---|---|---|---|
| PRICE_CLOSE | Tushare | `index_daily` / `sge_daily` | `close` | VALID |
| PE_TTM | Tushare | `index_dailybasic`；fallback `daily_basic` 聚合 | `pe_ttm` | VALID / aggregate |
| PB | Tushare | `index_dailybasic`；fallback `daily_basic` 聚合 | `pb` | VALID / aggregate |
| PS | Tushare | `daily_basic` 成分聚合 | `ps_ttm` | VALID/PARTIAL |
| DIVIDEND_YIELD | Tushare | `daily_basic` 成分聚合 | `dv_ttm` | VALID/PARTIAL |
| ROE | Tushare | `fina_indicator` 成分聚合 | `roe` | VALID/PARTIAL |
| EARNINGS_GROWTH | Tushare | `fina_indicator` 成分聚合 | `netprofit_yoy` | VALID/PARTIAL |
| REVENUE_GROWTH | Tushare | `fina_indicator` 成分聚合 | `tr_yoy` | VALID/PARTIAL |
| INDEX_EARNINGS_GROWTH | Tushare | `fina_indicator` 成分聚合 | `netprofit_yoy` | VALID/PARTIAL |
| PE_FORWARD | Proxy | `PE_TTM` 映射 | `pe_ttm` | PARTIAL |
| EXPECTED_EARNINGS_GROWTH | 暂缺 | — | — | Missing |
| PEG | 暂缺 | — | — | Missing |
| EARNINGS_REVISION | 暂缺 | — | — | Missing |
| EQUITY_RISK_PREMIUM | 暂缺 | — | — | Missing |
| REAL_YIELD_10Y | FRED | `DFII10` | `value` | VALID |
| DOLLAR_INDEX | FRED | `DTWEXBGS` | `value` | VALID |
| GOLD_ETF_FLOW_3M | Tushare proxy | `fund_share` + `fund_nav` | `fd_share`, `unit_nav` | PARTIAL |
| CENTRAL_BANK_DEMAND_SCORE | Manual/Future | — | — | LOW/Missing |
| DIVIDEND_STABILITY_SCORE | Tushare | `dividend` 聚合 | 分红实施记录 | VALID/PARTIAL |

---

# 4. 指数行情：index_daily

## 用途

为：

```text
VALUE_DIVIDEND
TECH_GROWTH
BROAD_EQUITY
```

获取：

```text
PRICE_CLOSE
MA20
MA60
MA200
Momentum 3M / 6M
```

## 请求

```json
{
  "api_name": "index_daily",
  "params": {
    "ts_code": "000300.SH",
    "start_date": "20210823",
    "end_date": "20260823"
  },
  "fields": "ts_code,trade_date,open,high,low,close,vol"
}
```

### 代理代码

```text
VALUE_DIVIDEND = 000016.SH
TECH_GROWTH    = 399006.SZ
BROAD_EQUITY   = 000300.SH
```

继续允许环境变量覆盖。

## 字段映射

```text
trade_date -> asOf
close      -> PRICE_CLOSE.value
open/high/low/vol -> PricePoint
```

## 时间

```text
observedAt  = trade_date 15:00 Asia/Shanghai
availableAt = trade_date 18:00 Asia/Shanghai
quality     = VALID
provider    = tushare
```

---

# 5. 黄金价格：sge_daily

## 请求

```json
{
  "api_name": "sge_daily",
  "params": {
    "ts_code": "Au99.99",
    "start_date": "20210823",
    "end_date": "20260823"
  },
  "fields": "ts_code,trade_date,open,high,low,close,price_avg,vol"
}
```

## 映射

```text
close -> GOLD PRICE_CLOSE
```

派生：

```text
MA20
MA60
MA200
Momentum3M
Momentum6M
PricePosition
DistanceFromMA200
```

### Quality

```text
VALID
```

---

# 6. 指数成分：index_weight

这是红利、科技、宽基缺失数据补全的核心 API。

## 请求

以 2026 年 8 月为例：

```json
{
  "api_name": "index_weight",
  "params": {
    "index_code": "000300.SH",
    "start_date": "20260801",
    "end_date": "20260831"
  },
  "fields": "index_code,con_code,trade_date,weight"
}
```

## 输出

```text
index_code
con_code
trade_date
weight
```

注意：

```text
weight 单位为 %
```

例如：

```text
0.8656
```

程序中转换为：

```ts
normalizedWeight = weight / 100
```

## 权重选择

对评分日 `T`：

```text
只允许使用 trade_date <= T 的最近一组指数权重
```

禁止：

```text
拿月底/下一期权重回填到更早日期
```

## 缓存表建议

新增：

```text
index_constituent_snapshots
```

至少包含：

```text
indexSymbol
effectiveDate
constituentSymbol
weight
provider
fetchedAt
```

唯一键：

```text
(indexSymbol, effectiveDate, constituentSymbol)
```

---

# 7. A 股每日估值：daily_basic

这是 2000 积分下最重要的接口之一。

官方允许按 `trade_date` 一次拉取全市场，单次最大约 6000 行。

## 请求

```json
{
  "api_name": "daily_basic",
  "params": {
    "trade_date": "20260821"
  },
  "fields": "ts_code,trade_date,pe_ttm,pb,ps_ttm,dv_ttm,total_mv"
}
```

## 字段映射

```text
pe_ttm  -> PE_TTM
pb      -> PB
ps_ttm  -> PS
dv_ttm  -> DIVIDEND_YIELD
total_mv -> 辅助检查/可选市值聚合
```

### 不使用

```text
ps
```

优先：

```text
ps_ttm
```

### 股息率

优先：

```text
dv_ttm
```

因为模型关注当前近 12 个月现金分红水平。

---

# 8. daily_basic 调用策略

禁止：

```text
300 个成分股 × 每天逐股调用 daily_basic
```

推荐：

```text
每天只请求一次全市场 daily_basic
↓
本地按指数成分过滤
↓
对三个指数分别聚合
```

因此每日估值 API 成本：

```text
daily_basic: 1 次 / 交易日
```

而非几百次。

## 历史初始化

第一版无需构建 5 年“每日”成分聚合估值。

使用：

```text
月频快照
```

即可用于长期估值百分位。

初始化过去 5 年：

```text
约 60 个自然月
×
每月最后一个有效交易日
```

即：

```text
约 60 次 daily_basic
```

然后与对应月份 `index_weight` 本地 join。

---

# 9. 指数 PE 聚合

如果 `index_dailybasic` 没权限：

对每个成分：

```text
weight_i
pe_ttm_i
```

过滤：

```text
PE > 0
finite
```

计算：

```text
validWeight = Σ weight_i

PE_index =
validWeight /
Σ(weight_i / PE_i)
```

这里权重先转成 0–1。

不要直接：

```text
Σ(weight_i * PE_i)
```

PE 使用加权调和形式更合理。

## Quality

```text
constituentCoverage = validWeight / totalWeight
```

```text
>= 0.80 -> VALID
0.60–0.80 -> PARTIAL
< 0.60 -> 不发布
```

---

# 10. 指数 PB 聚合

过滤：

```text
PB > 0
finite
```

公式：

```text
PB_index =
validWeight /
Σ(weight_i / PB_i)
```

Coverage/Quality 同 PE。

---

# 11. 指数 PS 聚合

字段：

```text
daily_basic.ps_ttm
```

过滤：

```text
PS_TTM > 0
```

公式：

```text
PS_index =
validWeight /
Σ(weight_i / PS_i)
```

输出：

```text
metricKey = PS
provider = tushare-index-aggregate
```

---

# 12. 指数股息率聚合

字段：

```text
daily_basic.dv_ttm
```

处理：

```text
null -> Missing
0 -> 有效 0
```

公式：

```text
DividendYield_index =
Σ(weight_i * dv_ttm_i)
/
Σ(valid weight_i)
```

输出：

```text
DIVIDEND_YIELD
```

用于：

```text
VALUE_DIVIDEND
```

---

# 13. fina_indicator

Tushare 2000 积分可调用，但当前常规接口以单只股票查询。

单次最多约 100 条记录，5 年季度历史通常足够放在一次请求中。

## 请求

```json
{
  "api_name": "fina_indicator",
  "params": {
    "ts_code": "600000.SH",
    "start_date": "20210101",
    "end_date": "20260823"
  },
  "fields": "ts_code,ann_date,end_date,roe,netprofit_yoy,tr_yoy,or_yoy,q_sales_yoy,update_flag"
}
```

## 本项目实际使用字段

```text
ann_date       -> availableAt
end_date       -> reportPeriod / observedAt
roe            -> ROE
netprofit_yoy  -> EARNINGS_GROWTH
tr_yoy         -> REVENUE_GROWTH
```

### 备用营收字段

```text
or_yoy
q_sales_yoy
```

v1.1 主模型统一使用：

```text
tr_yoy
```

避免同一历史序列中混用口径。

---

# 14. 财务数据的时间语义

这是回测必须严格处理的部分。

例如：

```text
end_date = 20260630
ann_date = 20260828
```

则：

```text
asOf      = 2026-06-30
observedAt = 2026-06-30T23:59:59+08:00
availableAt = 2026-08-28T08:00:00+08:00
```

在：

```text
2026-08-27
```

进行评分时：

```text
禁止使用该条数据
```

---

# 15. 必须修复数据库 revision 存储问题

当前：

```text
metric_observation_unique
```

使用：

```text
subjectType
subjectId
metricKey
provider
observedAt
```

作为唯一键。

财务数据可能对同一报告期出现：

```text
初始公告
修订公告
```

二者：

```text
observedAt 相同
availableAt 不同
```

如果只用 `observedAt` 唯一，后抓到的修订值会覆盖旧值，历史回测可能因此得到未来才知道的修订数据。

## v1.1 必须修改

唯一键至少加入：

```text
availableAt
```

改为：

```text
subjectType
subjectId
metricKey
provider
observedAt
availableAt
```

同步修改：

```text
src/db/schema.ts
commitProviderMetricObservations()
commitManualObservations()
repository resolve selection
Drizzle migration
```

## 读取规则

对 evaluation date `T`：

```text
候选：
asOf <= T
availableAt <= T
```

同一：

```text
metricKey + asOf + provider
```

如果存在多次 revision：

```text
选择 availableAt <= T 中最晚的一条
```

这是 v1.1 的硬验收项。

---

# 16. 财务数据缓存策略

三个指数成分会高度重叠。

先求：

```text
Union(
  VALUE_DIVIDEND constituents,
  TECH_GROWTH constituents,
  BROAD_EQUITY constituents
)
```

然后：

```text
每只股票只拉一次 fina_indicator 历史
```

本地缓存后用于三个指数。

建议新增：

```text
constituent_fundamental_cache
```

也可直接复用 `metric_observations`，但 `subjectType` 应支持：

```text
INSTRUMENT
```

当前数据库主要使用：

```text
ASSET_BUCKET
```

长期推荐扩展为：

```text
subjectType = INSTRUMENT
subjectId = 600000.SH
```

然后聚合器读取股票级 observation，生成资产桶级 observation。

---

# 17. ROE 聚合

字段：

```text
fina_indicator.roe
```

对评价日 T：

每个成分取：

```text
availableAt <= T
```

的最新一期 ROE。

为避免极端值：

```text
对有效 ROE 做 5% / 95% winsorize
```

然后：

```text
ROE_index =
Σ(weight_i * winsorizedROE_i)
/
Σ(validWeight_i)
```

输出：

```text
VALUE_DIVIDEND -> ROE
```

科技和宽基第一版可存但暂不参与当前评分模型。

---

# 18. 盈利增长聚合

字段：

```text
fina_indicator.netprofit_yoy
```

先：

```text
winsorize 5% / 95%
```

再：

```text
EarningsGrowth_index =
weighted mean(netprofit_yoy)
```

输出：

```text
VALUE_DIVIDEND -> EARNINGS_GROWTH
TECH_GROWTH    -> EARNINGS_GROWTH
BROAD_EQUITY   -> INDEX_EARNINGS_GROWTH
```

---

# 19. 营收增长聚合

字段：

```text
fina_indicator.tr_yoy
```

同样：

```text
winsorize 5% / 95%
weighted mean
```

输出：

```text
TECH_GROWTH -> REVENUE_GROWTH
```

---

# 20. 季度财务指标的成分匹配

指数成分权重日期与财务报告日期不会完全一致。

评价日 `T`：

```text
Step 1:
选择 T 之前最近的 index_weight snapshot

Step 2:
对每个成分选择 availableAt <= T 的最近财务 observation

Step 3:
按该指数 snapshot weight 聚合
```

禁止：

```text
要求所有股票必须是同一个 end_date
```

原因：

财报披露时间不同。

但数据状态页需要显示：

```text
latestReportPeriodMin
latestReportPeriodMax
constituentCoverage
```

---

# 21. 红利分红稳定性：dividend

上一版将 `DIVIDEND_STABILITY_SCORE` 暂留缺失。

在 2000 积分下，可以进一步自动补。

## API

```text
dividend
```

推荐请求字段：

```text
ts_code
ann_date
end_date
div_proc
cash_div_tax
record_date
ex_date
pay_date
```

如果运行时某字段不可用，允许 provider 在测试中降级到可用现金分红字段，但不能改用完全不同语义的数据。

## 只统计

```text
已实施 / 已完成的现金分红记录
```

不把：

```text
董事会预案
股东大会未实施方案
```

直接当成已支付分红。

---

# 22. 单股 Dividend Stability 子分

建议取最近 5 个完整年度：

定义：

```text
annualCashDividend[y]
```

评价：

```text
有现金分红年度数 = N
```

基础：

```text
N = 5 -> 80
N = 4 -> 65
N = 3 -> 50
N <=2 -> 30
```

再根据连续性：

```text
连续 5 年均有现金分红 +10
最近年度未中断 +5
最近 3 年现金分红明显持续下降 -10
出现最近年度完全取消现金分红 -20
```

clamp：

```text
0–100
```

这只是“稳定性”，不评价股息率高低。

---

# 23. 指数 Dividend Stability 聚合

每个成分获得：

```text
stockDividendStabilityScore
```

然后：

```text
IndexDividendStabilityScore =
Σ(weight_i * score_i)
/
Σ(validWeight_i)
```

Coverage：

```text
>=80% VALID
60–80% PARTIAL
<60% Missing
```

输出：

```text
DIVIDEND_STABILITY_SCORE
```

这样红利 Fundamental：

```text
Earnings Growth 40%
ROE 30%
Dividend Stability 30%
```

有机会达到完整覆盖。

---

# 24. 科技 Forward PE

当前仓库逻辑：

```text
PE_TTM
↓
PE_FORWARD
quality = PARTIAL
```

v1.1 保留。

Canonical Observation：

```text
metricKey = PE_FORWARD
provider = tushare-derived-forward-pe
quality = PARTIAL
```

UI 必须显示：

```text
Forward PE（TTM 代理）
```

不得显示成：

```text
Forward PE
```

并让用户误以为是真正一致预期市盈率。

---

# 25. 科技 Expected Earnings Growth / PEG

用户当前 2000 Tushare 权限下，不把一致预期数据作为 v1.1 强制依赖。

保持：

```text
EXPECTED_EARNINGS_GROWTH = Missing
PEG = Missing
EARNINGS_REVISION = Missing
```

Tech Cheapness：

```text
Forward PE 40% ✅ PARTIAL
PS         20% ✅
Growth Adjusted 40% ❌
```

Coverage：

```text
60%
```

因此：

```text
MEDIUM
```

符合真实能力。

---

# 26. 宽基 Earnings Growth

现有：

```text
deriveImpliedEarningsGrowth()
```

允许保留 fallback。

但优先级：

```text
tushare-index-aggregate
>
tushare-derived
```

真实聚合：

```text
INDEX_EARNINGS_GROWTH =
weighted winsorized netprofit_yoy
```

只要真实聚合可用：

```text
禁止当前评分选择 Price / PE 派生值
```

---

# 27. Price / PE 派生盈利

如果 fallback：

```text
E = Price / PE
Growth = E_t / E_t-252 - 1
```

必须：

```text
provider = tushare-derived
quality = PARTIAL
```

Confidence ceiling：

```text
MEDIUM
```

无论有多少年历史，都不能升级 HIGH。

---

# 28. 黄金实际利率：FRED

当前仓库已经有：

```text
FredProvider
```

但要增加 Canonical 映射。

## 映射

```ts
const FRED_SERIES_MAP = {
  REAL_YIELD_10Y: "DFII10",
  DOLLAR_INDEX: "DTWEXBGS",
} as const;
```

---

# 29. FRED REAL_YIELD_10Y

请求 Canonical：

```text
REAL_YIELD_10Y
```

Provider 实际请求：

```text
series_id = DFII10
```

取：

```text
date
value
realtime_start
```

输出：

```text
key = REAL_YIELD_10Y
unit = percent
quality = VALID
provider = fred
```

## 重要

当前 Tushare：

```text
us_trycr.y10
```

不能在没有确认其真实经济语义时继续标记为：

```text
REAL_YIELD_10Y / VALID
```

v1.1 主数据源直接改为 FRED `DFII10`。

---

# 30. FRED DOLLAR_INDEX

Canonical：

```text
DOLLAR_INDEX
```

FRED：

```text
DTWEXBGS
```

该序列表示美元广义指数。

页面名称改为：

```text
美元广义指数
```

避免 UI 写成“DXY”产生概念误差。

---

# 31. FRED API 请求示意

当前 `FredProvider` 已基本实现 URL 请求。

内部：

```text
series_id = FRED_SERIES_MAP[canonicalKey]
observation_start = range.start
observation_end = range.end
file_type = json
api_key = FRED_API_KEY
```

返回转换：

```text
observation.date -> asOf
observation.value -> value
observation.realtime_start -> availableAt basis
```

需要忽略：

```text
value = "."
```

---

# 32. 黄金 ETF Flow：2000 积分可做近似版

8000 积分有更直接的 ETF 份额规模接口。

用户当前 2000 积分先使用：

```text
fund_share
+
fund_nav
```

构造国内黄金 ETF 净申赎代理。

## 默认代理

建议配置：

```env
TUSHARE_GOLD_ETF_PROXIES=518880.SH,159934.SZ
```

程序必须允许覆盖。

---

# 33. fund_share

请求：

```json
{
  "api_name": "fund_share",
  "params": {
    "ts_code": "518880.SH",
    "start_date": "20260101",
    "end_date": "20260823"
  },
  "fields": "ts_code,trade_date,fd_share"
}
```

字段：

```text
fd_share = 基金份额，单位万份
```

---

# 34. fund_nav

请求：

```json
{
  "api_name": "fund_nav",
  "params": {
    "ts_code": "518880.SH",
    "start_date": "20260101",
    "end_date": "20260823"
  },
  "fields": "ts_code,ann_date,nav_date,unit_nav"
}
```

用于资金流估算时：

```text
使用 unit_nav
```

不要使用：

```text
adj_nav
```

因为流量估算需要当期每份基金净值。

---

# 35. 黄金 ETF 流量代理公式

单只 ETF：

```text
deltaShares_t =
(fd_share_t - fd_share_prev) * 10000
```

近似净流：

```text
flow_t =
deltaShares_t * unit_nav_t
```

单位：

```text
CNY
```

多个 ETF：

```text
GoldETFFlow_t =
Σ flow_etf,t
```

3 个月：

```text
GOLD_ETF_FLOW_3M =
Σ last 63 trading days GoldETFFlow_t
```

由于只覆盖部分国内黄金 ETF，且属于估算：

```text
provider = tushare-gold-etf-proxy
quality = PARTIAL
confidence ceiling = MEDIUM
```

这已经比完全缺失更有用。

---

# 36. 黄金央行购金

`CENTRAL_BANK_DEMAND_SCORE` 暂时不强制自动化。

原因：

```text
Tushare 2000 权限没有稳定、直接的全球央行购金 Canonical API
```

v1.1：

```text
Manual Provider
或
未来 Gold/WGC Provider
```

缺失时：

```text
Gold Fundamental:
Real Yield 40%
Dollar 30%
ETF Flow 20%
Central Bank 10% missing
```

有效覆盖：

```text
90%
```

如果 ETF Flow 代理可用，黄金整体 Confidence 可达到：

```text
MEDIUM
```

由于 ETF Flow 本身 PARTIAL，不强求 HIGH。

---

# 37. index_dailybasic 的处理

保留现有接口代码，但改成 capability probe。

第一次启动：

```text
请求一小段 index_dailybasic
```

例如：

```json
{
  "api_name": "index_dailybasic",
  "params": {
    "ts_code": "000016.SH",
    "start_date": "20260801",
    "end_date": "20260823"
  },
  "fields": "ts_code,trade_date,pe_ttm,pb"
}
```

如果：

```text
code = 0
```

记录：

```text
capability.index_dailybasic = READY
```

如果：

```text
code = 2002
```

记录：

```text
PERMISSION_DENIED
```

以后本次运行直接走聚合 fallback，避免反复请求失败。

---

# 38. Provider 新接口建议

在 `TushareProvider` 增加：

```ts
getIndexWeights()
getMarketDailyBasics()
getEquityFundamentals()
getEquityDividendHistory()
getFundShare()
getFundNavForFlow()
```

不要把所有逻辑继续塞进：

```text
getValuationMetrics()
```

因为指数聚合需要批量和缓存语义。

---

# 39. 新建聚合器

新增：

```text
src/providers/tushare/index-aggregator.ts
```

建议类型：

```ts
export interface IndexAggregateContext {
  indexSymbol: string;
  evaluationDate: string;
  weights: IndexWeightPoint[];
  dailyBasics: DailyBasicRow[];
  fundamentals: EquityFundamentalSnapshot[];
}

export interface AggregateMetricResult {
  metricKey: CanonicalMetricKey;
  value: number | null;
  constituentCoverage: number;
  constituentCount: number;
  validConstituentCount: number;
  quality: "VALID" | "PARTIAL";
  effectiveDate: string;
}
```

---

# 40. Aggregate Provider 名称

写入 observation：

```text
provider = tushare-index-aggregate
```

必须与：

```text
tushare
tushare-derived
```

区分。

---

# 41. 具体资产数据方案

## GOLD

```text
PRICE_CLOSE
  sge_daily.close

REAL_YIELD_10Y
  FRED DFII10

DOLLAR_INDEX
  FRED DTWEXBGS

GOLD_ETF_FLOW_3M
  fund_share.fd_share
  + fund_nav.unit_nav

CENTRAL_BANK_DEMAND_SCORE
  missing/manual
```

---

## VALUE_DIVIDEND

```text
PRICE_CLOSE
  index_daily.close

PE_TTM
  index_dailybasic.pe_ttm
  fallback aggregate daily_basic.pe_ttm

PB
  index_dailybasic.pb
  fallback aggregate daily_basic.pb

DIVIDEND_YIELD
  aggregate daily_basic.dv_ttm

EARNINGS_GROWTH
  aggregate fina_indicator.netprofit_yoy

ROE
  aggregate fina_indicator.roe

DIVIDEND_STABILITY_SCORE
  aggregate dividend history
```

---

## TECH_GROWTH

```text
PRICE_CLOSE
  index_daily.close

PE_FORWARD
  PE_TTM proxy
  quality=PARTIAL

PS
  aggregate daily_basic.ps_ttm

EARNINGS_GROWTH
  aggregate fina_indicator.netprofit_yoy

REVENUE_GROWTH
  aggregate fina_indicator.tr_yoy

EXPECTED_EARNINGS_GROWTH
  missing

PEG
  missing

EARNINGS_REVISION
  missing
```

---

## BROAD_EQUITY

```text
PRICE_CLOSE
  index_daily.close

PE_TTM
  direct/fallback aggregate

PB
  direct/fallback aggregate

INDEX_EARNINGS_GROWTH
  aggregate fina_indicator.netprofit_yoy

EQUITY_RISK_PREMIUM
  missing in v1.1

EARNINGS_REVISION
  missing
```

---

# 42. Confidence 数据结构升级

现有：

```ts
MetricSeries
```

增加：

```ts
quality: "VALID" | "PARTIAL" | undefined
```

历史点增加：

```ts
quality
```

`scoreHistoricalMetric()`：

```text
history >= 3y + VALID -> HIGH eligible
history >= 1y         -> MEDIUM eligible
PARTIAL               -> max MEDIUM
manual                -> LOW
```

---

# 43. Coverage 阈值

配置：

```json
{
  "confidence": {
    "highCoverage": 0.8,
    "mediumCoverage": 0.6
  }
}
```

判定：

```text
coverage >= 0.80 -> HIGH eligible
0.60 <= coverage < 0.80 -> MEDIUM
coverage < 0.60 -> LOW
```

最终再与：

```text
source confidence
quality confidence
history confidence
```

取较低值。

---

# 44. MEDIUM 对动作的限制

如果总体：

```text
confidence = MEDIUM
```

则：

```text
STRONG_ADD_ALLOWED -> LIGHT_ADD_ALLOWED
REDUCE_CONSIDER    -> DO_NOT_ADD
```

保留：

```text
LIGHT_ADD_ALLOWED
HOLD
DO_NOT_ADD
```

LOW：

```text
LOW_CONFIDENCE
allowAdd = false
```

---

# 45. 自动刷新调度

## 每交易日

```text
index_daily
sge_daily
daily_basic
FRED DFII10
FRED DTWEXBGS
fund_share
fund_nav
```

## 每月

```text
index_weight
月末指数聚合估值历史点
```

## 每周检查

```text
fina_indicator 是否出现新 ann_date
dividend 是否出现新实施记录
```

首次建库再拉 5 年历史。

---

# 46. 首次初始化顺序

```text
1. 拉三个指数 5 年 index_daily
2. 拉 Au99.99 5 年 sge_daily
3. 拉 FRED 5 年宏观
4. 拉 60 个月 index_weight
5. 拉 60 个估值 snapshot date 的 daily_basic
6. 得到 5 年月频 PE/PB/PS/DividendYield 聚合
7. 求三个指数成分 union
8. 每只股票拉一次 5 年 fina_indicator
9. 生成历史季度 ROE/EarningsGrowth/RevenueGrowth
10. 拉 VALUE_DIVIDEND 成分 dividend 历史
11. 拉黄金 ETF fund_share/fund_nav
12. 生成 Canonical observations
13. refreshScoresForBuckets()
```

---

# 47. Rate limiter

统一封装：

```text
src/providers/tushare/rate-limiter.ts
```

默认：

```ts
{
  maxRequestsPerMinute: 120,
  concurrency: 3,
  retries: 2
}
```

`2000` 积分官方通用上限虽然更高，本项目使用更保守的默认值。

---

# 48. 增量刷新

每次普通刷新禁止重新拉完整 5 年。

保存：

```text
lastSuccessfulAsOf
lastIndexWeightMonth
lastFinancialAnnouncementDateBySymbol
lastDividendAnnouncementDateBySymbol
```

然后只请求：

```text
增量窗口
```

提供：

```text
FULL_BACKFILL=true
```

时才执行完整历史构建。

---

# 49. Repository Provider 优先级

配置：

```ts
primaryProviderByMetric = {
  REAL_YIELD_10Y: "fred",
  DOLLAR_INDEX: "fred",
  PS: "tushare-index-aggregate",
  DIVIDEND_YIELD: "tushare-index-aggregate",
  ROE: "tushare-index-aggregate",
  EARNINGS_GROWTH: "tushare-index-aggregate",
  REVENUE_GROWTH: "tushare-index-aggregate",
  INDEX_EARNINGS_GROWTH: "tushare-index-aggregate",
  DIVIDEND_STABILITY_SCORE: "tushare-index-aggregate",
  GOLD_ETF_FLOW_3M: "tushare-gold-etf-proxy"
}
```

PE/PB：

```text
tushare official direct
>
tushare-index-aggregate
```

科技 Forward PE：

```text
真实 provider（未来）
>
tushare-derived-forward-pe
```

---

# 50. 页面数据解释

每个组件显示：

```text
Value
Score
Percentile
Provider
Quality
As Of
Coverage
Confidence
```

例：

```text
科技 / Forward PE

值：34.2x
来源：TTM PE Proxy
Provider：tushare-derived-forward-pe
Quality：PARTIAL
Confidence：MEDIUM
```

---

# 51. 数据状态页必须区分三种问题

```text
MISSING
PERMISSION_DENIED
PARTIAL_PROXY
```

禁止全部显示成：

```text
“缺数据”
```

例：

```text
Expected Earnings Growth
MISSING
当前 2000 积分数据源未提供一致预期

Forward PE
PARTIAL_PROXY
使用 TTM PE 代理

index_dailybasic
PERMISSION_DENIED
已自动切换成分股聚合
```

---

# 52. 必须修改的现有文件

```text
src/db/schema.ts

src/providers/types.ts
src/providers/tushare/index.ts
src/providers/tushare/proxies.ts
src/providers/fred/index.ts

src/metrics/observation-repository.ts

src/domain/scoring/types.ts
src/domain/scoring/percentile.ts
src/domain/scoring/models.ts
src/domain/scoring/engine.ts
src/domain/scoring/config.ts
src/domain/scoring/default-config.json

src/server/automatic-data-refresh-service.ts
src/server/scoring-refresh-service.ts

app/(product)/data-status/page.tsx
app/(product)/scores/page.tsx

docs/automatic-data-refresh.md
```

---

# 53. 建议新增文件

```text
src/providers/tushare/index-aggregator.ts
src/providers/tushare/rate-limiter.ts
src/providers/tushare/index-weight-cache.ts
src/providers/tushare/fundamentals-cache.ts
src/providers/tushare/gold-etf-flow.ts

tests/unit/index-aggregator.test.ts
tests/unit/confidence-v1-1.test.ts
tests/unit/gold-etf-flow.test.ts
tests/integration/automatic-data-refresh-v1-1.test.ts
```

---

# 54. 数据库 Migration

新增 migration：

```text
metric_observation_unique
```

从：

```text
subjectType
subjectId
metricKey
provider
observedAt
```

调整到：

```text
subjectType
subjectId
metricKey
provider
observedAt
availableAt
```

如果新增指数成分表：

```sql
index_constituent_snapshots
```

需要单独 migration。

---

# 55. 核心测试

## daily_basic

模拟一日全市场：

```text
000001.SZ
600000.SH
300750.SZ
...
```

验证按：

```text
index_weight
```

正确过滤。

---

## PE 聚合

输入：

```text
A weight=60%, PE=10
B weight=40%, PE=20
```

验证：

```text
PE =
1 / (0.6/10 + 0.4/20)
= 12.5
```

---

## 股息率

```text
A 60%, yield=5%
B 40%, yield=2%
```

结果：

```text
3.8%
```

---

## Coverage

```text
全部权重 100
有效 85
=> VALID

有效 70
=> PARTIAL

有效 55
=> 不发布
```

---

## Revision 防前视

存在：

```text
2025Q4
ann_date=20260320 value=10
revision ann_date=20260410 value=14
```

在：

```text
2026-03-31
```

评分必须使用：

```text
10
```

在：

```text
2026-04-11
```

才允许使用：

```text
14
```

---

## Tech PE proxy

```text
PE_TTM -> PE_FORWARD
quality=PARTIAL
```

验证：

```text
5 年历史仍最高 MEDIUM
```

---

## Gold

存在：

```text
DFII10
DTWEXBGS
ETF flow proxy
```

央行购金缺失：

```text
Fundamental coverage = 90%
```

但由于 ETF Flow 为 PARTIAL：

```text
Gold overall <= MEDIUM
```

---

# 56. 预期完成后的 Confidence

### GOLD

```text
Cheapness   HIGH
Fundamental MEDIUM
Trend       HIGH

Overall = MEDIUM
```

### VALUE_DIVIDEND

如果 dividend stability 成功补齐：

```text
Cheapness   HIGH
Fundamental HIGH/MEDIUM
Trend       HIGH

Overall = HIGH 或 MEDIUM
```

### TECH_GROWTH

```text
Cheapness   MEDIUM
Fundamental HIGH
Trend       HIGH

Overall = MEDIUM
```

### BROAD_EQUITY

真实成分聚合盈利成功：

```text
Cheapness   HIGH
Fundamental HIGH
Trend       HIGH

Overall = HIGH
```

---

# 57. Codex 验收 Checklist

- [ ] 2000 积分下 `index_dailybasic` 权限不足不会导致评分链路失败
- [ ] `daily_basic` 使用按 `trade_date` 全市场拉取
- [ ] `index_weight.weight` 正确除以 100
- [ ] PE/PB/PS 使用调和聚合
- [ ] 股息率使用权重平均
- [ ] ROE/盈利增长/营收增长执行 winsorize + 权重平均
- [ ] `fina_indicator.ann_date` 写入 `availableAt`
- [ ] 数据 revision 不覆盖过去可见版本
- [ ] `tushare-derived` 永远不能因历史够长自动变 HIGH
- [ ] `PE_TTM -> PE_FORWARD` 明确 PARTIAL
- [ ] FRED `DFII10` 映射为 `REAL_YIELD_10Y`
- [ ] FRED `DTWEXBGS` 映射为 `DOLLAR_INDEX`
- [ ] 黄金 ETF Flow 使用 `fd_share + unit_nav` 时标记 PARTIAL
- [ ] dividend stability 只统计已实施现金分红
- [ ] Coverage >=80% / >=60% / <60% 正确映射
- [ ] MEDIUM 限制极端增减配状态
- [ ] 自动刷新为增量刷新
- [ ] full backfill 有独立开关
- [ ] 数据状态页显示 source / quality / coverage / permission
- [ ] 所有回测使用 `availableAt <= evaluationDate`
- [ ] 新增 migration 已测试
- [ ] 原有评分测试全部通过

---

# 58. 官方接口核验基准

本实施版按 2026-08-23 官方文档口径核验：

```text
Tushare
- index_daily
- index_weight
- daily_basic
- fina_indicator
- fund_share
- fund_nav
- sge_daily
- dividend
- 权限/频次表

FRED
- DFII10
- DTWEXBGS
```

实施时如果 Tushare 返回：

```text
code=2002
```

统一作为：

```text
PERMISSION_DENIED
```

执行文档定义的 fallback。

---

# 59. 最终实施原则

本项目不追求“所有指标都有值”。

优先顺序：

```text
数据语义正确
>
历史无前视
>
数据质量真实
>
覆盖率足够
>
评分完整
```

出现缺失时：

```text
合理降权 / 降 Confidence
```

出现代理时：

```text
明确 PARTIAL
```

只有真实、高质量、足够历史的数据：

```text
才允许 HIGH
```
