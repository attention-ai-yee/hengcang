# 个人资产配置与估值轮动 Dashboard — Codex 实施设计文档

**版本**：v1.0  
**用途**：直接交给 Codex，用于规划、实现、测试并交付一个可运行的个人投资决策支持网站。  
**定位**：个人资产配置 / 估值监控 / 风险控制 / 决策日志工具。  
**核心原则**：网站负责客观计算与展示，人工负责最终决策；系统不得自动下单。

---

## 0. 给 Codex 的执行要求

请把本文件视为完整的产品需求文档（PRD）+ 技术设计草案（TDD）。执行时请遵守：

1. 先输出一份简洁的实施计划和目录结构，然后直接开始实现，不要只停留在脚手架。
2. 优先完成可运行的 MVP；所有页面必须有真实的数据流和可操作状态，避免只做静态 mock。
3. 对暂时无法免费、稳定获取的数据，必须实现 **Provider Adapter + Manual Fallback**，严禁把某个不稳定网页抓取逻辑散落在业务代码里。
4. 所有数据都要显示 `as_of` / 数据更新时间。估值、财务和宏观数据不能伪装成实时行情。
5. 所有评分公式、权重、阈值必须可配置，不允许硬编码到 UI。
6. 所有“加仓/减仓”提示只能作为决策支持，禁止自动交易，禁止连接券商执行委托。
7. 对关键算法写单元测试；对资产分类、评分、仓位上限、去重/迟滞机制写测试。
8. 完成后提供：README、环境变量示例、初始化方式、数据源配置说明、测试命令、部署说明。
9. 如果需求存在歧义，优先采用本文中的“安全默认值”，并把可调整项放入 Settings 页面。
10. 最终交付应能让一个个人用户在本地或云端启动，手工录入持仓后立即看到资产分布、风险集中度、评分和再平衡提示。

---

# 1. 产品目标

构建一个面向个人投资者的资产配置网站，用于回答三个核心问题：

1. **我现在的钱分别放在哪里？**
2. **黄金、红利/价值、科技/成长、现金/债券当前分别处于什么状态？**
3. **在考虑估值、基本面、趋势和仓位上限以后，我当前应该“允许增配、保持、停止加仓、轻度减配、明显减配”中的哪一种？**

这个工具的目标是降低主观冲动、避免下跌途中无限补仓、减少高频交易，并把投资决策变成一套可回溯、可量化、可测试的规则。

该系统不是选股机器人，不追求预测短期涨跌，不提供保证收益的结论。

---

# 2. 用户当前资产基线（手工输入，首次启动可编辑）

> 以下数据来自用户手工描述，未与金融账户自动同步。系统必须允许用户修改精确值，并对“约数”打标。

| 账户/资产 | 当前市值 | 备注 |
|---|---:|---|
| 现金 | ¥80,000 | 高流动性 |
| 股票账户（同花顺） | ¥220,000 | 原投入约 ¥270,000，当前累计浮亏约 ¥50,000 |
| 债券基金 | ¥160,000 | 支付宝 |
| 中欧红利优享灵活配置混合A（004814） | ¥100,000 | 红利/价值核心仓 |
| 黄金 | ¥20,000+ | 约数，首次启动要求用户补精确值 |
| 其他 A 股科技基金 / 中证 A500 等 | ¥10,000+ | 约数，首次启动要求用户补精确值 |

**重要：** 当前明细合计至少约 ¥590,000，因此系统不得固定写死“总资产 50 万”。总资产必须始终由当前持仓实时求和得到。

股票账户中目前较大的风险集中来自：

- 港股互联网 ETF；
- 先导智能；
- 二者合计历史投入 20 万以上，均曾出现约 20% 级别亏损；
- 用户曾在下跌过程中持续补仓，导致集中度进一步提高。

因此 MVP 必须把“资产大类分散”和“单一标的/单一主题集中风险”分开显示。

---

# 3. 资产模型

系统使用 4 个一级资产桶：

1. **Cash & Bonds：现金 / 货币基金 / 短债 / 债券基金**
2. **Gold：黄金**
3. **Value & Dividend：红利 / 价值**
4. **Tech & Growth：科技 / 成长**

另设：

5. **Other：暂未归类资产**

### 3.1 为什么需要四类

“黄金 + 红利 + 科技”可以形成风格互补，但缺少一个等待机会的低波动仓位。现金/债券需要作为正式资产桶纳入模型，用于：

- 提供流动性；
- 在多个风险资产都偏贵时等待；
- 市场深度回撤时提供再平衡资金；
- 降低整个账户回撤。

### 3.2 资产分类规则

每个 Holding 必须具有：

- `asset_bucket`
- `instrument_type`
- `region`
- `theme`
- `is_single_stock`
- `is_thematic_etf`
- `is_approximate`

用户可以手工覆盖自动分类。

示例：

- 004814 → `VALUE_DIVIDEND`
- 黄金 ETF / 积存金 → `GOLD`
- 港股互联网 ETF → `TECH_GROWTH` + `HK` + `INTERNET`
- 先导智能 → `TECH_GROWTH` + `CN_A` + `AUTOMATION`
- 债券基金 → `CASH_BONDS`

---

# 4. 战略仓位与风险预算

默认值只作为初始模板，必须允许用户在 Settings 中修改。

| 资产桶 | 中性目标 | 默认允许区间 |
|---|---:|---:|
| Cash & Bonds | 30% | 20%–40% |
| Gold | 10% | 5%–15% |
| Value & Dividend | 25% | 15%–35% |
| Tech & Growth | 30% | 20%–40% |
| Other | 5% | 0%–10% |

### 4.1 集中度硬约束

默认风险约束：

- 单一个股：不超过总资产 **8%**；
- 单一主题 ETF：不超过总资产 **15%**；
- 单一行业/主题：不超过总资产 **20%**；
- 单一资产桶：不得突破其用户设定的硬上限；
- 当某标的超过上限时，系统状态必须显示 `OVERWEIGHT`，即使评分很高也禁止继续加仓。

这些阈值必须可配置。

### 4.2 补仓规则

系统必须明确禁止以下逻辑：

> “因为价格跌了很多，所以自动继续补仓。”

允许增配必须同时满足：

- 基本面没有显著恶化；
- 当前仓位低于上限；
- 机会评分达到阈值；
- 没有硬风险警报；
- 通过迟滞 / 冷却机制。

---

# 5. 评分体系

每个资产桶至少展示 4 个分数：

1. **Valuation Score（估值/拥挤度）**：0–100，越高越贵/越拥挤；
2. **Fundamental Score（基本面）**：0–100，越高越健康；
3. **Trend Score（趋势）**：0–100，越高趋势越强；
4. **Opportunity Score（机会评分）**：0–100，越高越适合增配。

所有分数都必须展示组成项和权重，禁止只显示一个黑箱分数。

## 5.1 通用机会评分

初始公式：

```text
OpportunityScore =
    0.45 * (100 - ValuationScore)
  + 0.35 * FundamentalScore
  + 0.20 * TrendScore
  - RiskPenalty
```

其中：

- `RiskPenalty` 默认 0–30；
- 若基本面低于 35，`OpportunityScore` 上限强制压到 40；
- 若仓位超过硬上限，状态直接为 `DO_NOT_ADD`；
- 若出现数据质量问题，评分标记 `LOW_CONFIDENCE`。

## 5.2 操作区间

```text
Opportunity >= 75  -> STRONG_ADD_ALLOWED
60–74              -> LIGHT_ADD_ALLOWED
40–59              -> HOLD
25–39              -> LIGHT_REDUCE
< 25               -> REDUCE_CONSIDER
```

最终动作还必须结合当前仓位：

- 若评分高但已经超配 → `HOLD / REDUCE TO LIMIT`
- 若评分低但仓位很低 → `DO NOT ADD`，不强制卖出
- 若基本面恶化 → 优先显示基本面风险，而非机械依赖估值分

---

# 6. 各资产桶的评分方法

## 6.1 Gold

黄金没有 PE、PB 和现金流，评分不能套股票模型。

### Valuation / Crowding 指标建议

- 金价相对 200 日均线偏离度；
- 金价相对 2 年 / 5 年趋势的标准化偏离；
- 近 1/3/5 年价格历史分位；
- 黄金 ETF 资金流 / 期货净头寸（若数据可得）；
- 波动率和短期超买指标。

### Fundamental / Macro 指标建议

- 美国 10Y 实际利率（反向因子）；
- 美元指数或广义美元指数（反向因子）；
- 全球央行购金趋势；
- 黄金 ETF 中期资金流；
- 美国财政/流动性环境的结构化代理指标。

### Trend 指标

- 20/60/200 日均线关系；
- 价格是否位于 200 日均线上方；
- 3M / 6M / 12M 动量；
- 突破后是否维持。

## 6.2 Value & Dividend

### Valuation

- PE 历史百分位；
- PB 历史百分位；
- 股息率历史百分位（反向转换为“贵/便宜”）；
- 股息率 - 无风险利率利差；
- 相对宽基指数估值折价/溢价。

### Fundamental

- 盈利增速；
- ROE；
- 自由现金流；
- 分红覆盖能力；
- 资产负债率 / 利息覆盖；
- 对基金类资产增加：基金经理是否变更、风格是否漂移、重仓集中度是否异常变化。

### Trend

- 20/60/200 日均线；
- 相对沪深 300 / 中证 A500 / 恒生指数的 3M、6M 相对强弱；
- 市场宽度。

## 6.3 Tech & Growth

### Valuation

- Forward PE / TTM PE；
- PE 历史百分位；
- PS（适用于部分高增长板块）；
- PEG 或估值/盈利增速匹配度；
- 相对宽基指数估值溢价。

### Fundamental

- 收入增速；
- 盈利增速；
- 分析师盈利预期上修/下修（若数据可得）；
- 毛利率 / ROE / 自由现金流；
- 产业景气代理指标，例如 AI Capex、半导体周期、互联网广告/云增长等。

### Trend

- 20/60/200 日均线；
- 3M / 6M / 12M 动量；
- 成交量确认；
- 相对宽基指数强弱。

## 6.4 Cash & Bonds

这一桶不需要传统“便宜/贵”评分，重点是：

- 当前收益率；
- 久期风险；
- 信用风险；
- 作为再平衡资金的可用比例。

可以显示：

- `Safety Score`
- `Yield Score`
- `Liquidity Score`

但不强制纳入 OpportunityScore。

---

# 7. 迟滞、去噪与信号确认

系统要刻意避免高频操作。

## 7.1 迟滞（Hysteresis）

若资产从 `HOLD` 进入 `LIGHT_ADD_ALLOWED`，需要满足：

- 分数连续 3 个交易日处于新区域；或
- 周度评分确认一次；

除非出现硬风险事件。

## 7.2 冷却期

一次手工执行“加仓/减仓”并记录 Decision Log 后，默认 **7 天冷却期**，冷却期内系统仍可更新评分，但不重复给同方向操作建议。

## 7.3 去重

若只是同一趋势继续上涨/下跌，状态保持不变，不产生新警报。

只有以下情况触发高优先级提醒：

- 评分跨越两个以上区间；
- Fundamental Score 跌破 35；
- 硬仓位上限被突破；
- 关键趋势由多转空或由空转多；
- 数据源或评分出现重大异常。

---

# 8. 页面与 UX

## 8.1 Dashboard / 首页

首页一屏回答：

- 总资产；
- 资产大类占比；
- 当前目标占比；
- 当前偏离；
- 四大资产桶评分；
- 最大集中风险；
- 最近一个需要关注的动作。

组件：

1. Total Portfolio Value
2. Allocation Donut / Bar
3. Target vs Actual
4. Asset Bucket Score Cards
5. Concentration Risk Card
6. Latest Signals
7. Data Freshness

## 8.2 Asset Scores / 资产评分页

每个资产桶展示：

- Valuation Score
- Fundamental Score
- Trend Score
- Opportunity Score
- 组成指标
- 历史评分曲线
- 当前状态
- 当前仓位 vs 目标区间
- 关键风险

必须能展开查看“为什么是这个分数”。

## 8.3 Holdings & Risk / 持仓与风险页

列出：

- 标的名称 / 代码；
- 当前市值；
- 成本；
- 盈亏；
- 占总资产；
- 占所属资产桶；
- 单一标的上限；
- 是否超配；
- 所属主题；
- 数据更新时间。

重点突出港股互联网 ETF、先导智能等高集中持仓。

## 8.4 Rebalance / 再平衡页

展示：

- 当前仓位；
- 中性目标；
- 允许区间；
- 若回到中性目标，需要增加/减少的金额；
- 但只有符合动作规则时才显示“允许执行”。

禁止显示精确“必须买入 X 元”的强制指令。建议文案使用：

- 可增配
- 可小幅增配
- 保持
- 停止新增
- 可小幅减配
- 需要降低集中度

## 8.5 Decision Log / 决策日志

记录每次用户手工决策：

- 日期；
- 标的 / 资产桶；
- 当时四项评分；
- 当时仓位；
- 用户动作；
- 用户理由；
- 系统状态；
- 30/90/180 天后结果（后续自动回填）。

此页面是整个系统长期迭代的关键。

## 8.6 Backtest / 回测页

最少支持：

- 固定比例再平衡；
- 评分驱动再平衡；
- Buy & Hold 基准；
- 月度/季度再平衡频率；
- 交易成本假设。

输出：

- CAGR；
- 最大回撤；
- 波动率；
- Sharpe（可选）；
- 最差年度；
- 最长回撤期；
- 换手率；
- 交易次数。

## 8.7 Settings / 设置页

可配置：

- 目标仓位；
- 上下限；
- 单股/主题上限；
- 评分权重；
- 动作阈值；
- 冷却期；
- 数据源；
- API Keys；
- 刷新频率；
- 默认货币 CNY。

---

# 9. 数据源架构

## 9.1 强制使用 Provider Adapter

定义统一接口，例如：

```ts
interface MarketDataProvider {
  getPriceSeries(symbol: string, range: DateRange): Promise<PricePoint[]>;
  getValuationMetrics(symbol: string): Promise<ValuationMetrics | null>;
  getFundamentalMetrics(symbol: string): Promise<FundamentalMetrics | null>;
  getMacroSeries(series: MacroSeriesId, range: DateRange): Promise<MetricPoint[]>;
}
```

实现时至少提供：

- `ManualProvider`
- `MacroProvider`
- `ChinaMarketProvider`
- `GlobalMarketProvider`

具体供应商可替换。

## 9.2 MVP 数据策略

优先保证稳定性和可解释性：

- 宏观：优先官方或稳定 API；
- A 股 / 港股：优先合法授权或用户自有 API Key；
- 无可靠 API 时允许 CSV/JSON 手工导入；
- 行情可以 15 分钟级 / 日频；
- 估值和基本面本身按日频/季频更新即可；
- UI 永远显示 `Last updated`。

“实时”在产品中定义为：**当前页面能自动刷新并明确标注数据新鲜度**，不承诺交易所级 tick 实时。

---

# 10. 建议技术栈

## 10.1 前端/全栈

推荐：

- Next.js (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui 或同类轻量组件库
- Recharts / ECharts（二选一）

## 10.2 数据层

MVP：

- SQLite + Drizzle ORM

云部署可切换：

- PostgreSQL / Neon / Supabase（任选其一）

## 10.3 定时任务

支持两种模式：

- 本地：Node scheduler；
- 云端：平台 Cron / GitHub Actions 调用 refresh endpoint。

每天至少：

- 收盘后更新价格/估值；
- 每日更新宏观数据；
- 季报/财报数据按供应商更新频率抓取。

---

# 11. 数据模型

建议核心实体：

```text
Portfolio
Holding
AssetBucket
Instrument
PriceObservation
MetricObservation
ScoreSnapshot
AllocationTarget
RiskLimit
Signal
DecisionLog
DataSourceStatus
BacktestRun
BacktestResult
```

### 11.1 Holding 关键字段

```text
id
portfolio_id
symbol
name
instrument_type
asset_bucket
region
theme
quantity
cost_basis
market_value_manual
currency
is_single_stock
is_thematic_etf
is_approximate
notes
```

### 11.2 ScoreSnapshot

```text
id
asset_bucket
as_of
valuation_score
fundamental_score
trend_score
opportunity_score
risk_penalty
confidence
state
components_json
```

### 11.3 Signal

```text
id
asset_bucket
created_at
severity
signal_type
old_state
new_state
summary
is_duplicate
acknowledged_at
```

---

# 12. API / 服务边界

建议 API：

```text
GET  /api/portfolio
POST /api/portfolio/holdings
PATCH /api/portfolio/holdings/:id
DELETE /api/portfolio/holdings/:id

GET  /api/allocation
GET  /api/scores
GET  /api/scores/:bucket/history
GET  /api/risk
GET  /api/signals
POST /api/decision-log

POST /api/data/refresh
GET  /api/data/status

POST /api/backtest
GET  /api/backtest/:id

GET  /api/settings
PATCH /api/settings
```

评分引擎与 API 解耦，建议放在：

```text
src/domain/scoring/
src/domain/allocation/
src/domain/risk/
src/domain/backtest/
```

---

# 13. 风险引擎

Risk Engine 与 Score Engine 分开。

至少检测：

1. 单股超限；
2. 主题 ETF 超限；
3. 资产桶超限；
4. 同一主题聚合超限；
5. 下跌补仓次数过多；
6. 过去 N 天内连续同方向交易；
7. 基本面恶化但仍持续加仓；
8. 数据过期；
9. 估值分低但基本面分同时极低（价值陷阱）；
10. 资产间相关性显著上升导致“看似分散、实际同跌”的风险。

风险等级：

- INFO
- WATCH
- WARNING
- CRITICAL

CRITICAL 必须压过普通评分提示。

---

# 14. 回测原则

回测必须避免明显的前视偏差。

要求：

- 使用当时可获得的数据；
- 财报数据按披露日期生效；
- 交易信号在下一可交易时点执行；
- 支持交易成本；
- 不允许使用未来估值百分位直接决定过去信号；
- 历史百分位只能使用当时之前的样本滚动计算。

至少对比：

1. Buy & Hold；
2. 固定比例季度再平衡；
3. 评分模型；
4. 评分模型 + 仓位上限；
5. 评分模型 + 仓位上限 + 迟滞。

目标不是找“历史收益最高”的参数，而是寻找：

- 最大回撤可接受；
- 换手率低；
- 参数对小变动不敏感；
- 在不同市场阶段均不过度失效。

---

# 15. 个人持仓的特殊处理

## 15.1 港股互联网 ETF

系统需要显示：

- 当前市值；
- 成本；
- 浮亏；
- 占总资产比例；
- 占 Tech & Growth 比例；
- 是否超过主题 ETF 上限；
- 港股互联网整体估值/基本面/趋势；
- 允许增配前必须同时满足仓位与评分条件。

## 15.2 先导智能

属于单一个股，必须使用更严格风险预算。

默认：

- 单股上限 8%；
- 若已超过上限，系统即使判断估值低，也显示 `DO_NOT_ADD`；
- 若基本面持续恶化，显示 `REASSESS_THESIS`；
- 不允许仅因为亏损比例大而提高 OpportunityScore。

## 15.3 中欧红利A（004814）

资产桶：`VALUE_DIVIDEND`。

除净值和估值代理外，增加基金维度监控：

- 基金经理变更；
- 前十大持仓变化；
- 行业暴露变化；
- 重仓集中度；
- 风格漂移；
- 相对同类 / 自身风格基准的持续偏离。

---

# 16. 数据质量与可信度

每个 ScoreSnapshot 必须有 `confidence`：

```text
HIGH
MEDIUM
LOW
```

降级条件：

- 关键指标缺失；
- 数据超过允许时效；
- 只能使用手工值；
- 数据源冲突；
- 估值样本历史不足。

当 confidence = LOW：

- UI 明显标记；
- 禁止输出 STRONG_ADD_ALLOWED；
- 建议状态最多为 HOLD / WATCH。

---

# 17. 提醒与通知

MVP 内置站内通知即可。

后续可增加：

- Email
- Web Push
- Telegram / 企业微信等 webhook

触发原则：

- 不为日常波动频繁提醒；
- 同方向状态不重复；
- 只有跨区间、基本面恶化、仓位超限、关键趋势反转时提醒。

网站负责量化信号；ChatGPT 定时任务可以继续承担新闻、政策、基金经理变更、宏观异常等定性监控。两者互补。

---

# 18. 安全与隐私

1. 默认本地优先；
2. API Key 只放环境变量，不写进前端 bundle；
3. 不保存券商登录密码；
4. MVP 不连接交易账户；
5. 不自动下单；
6. 所有用户持仓数据可导出 / 删除；
7. 云部署时必须启用登录保护；
8. 日志中不能打印 API Key 或敏感持仓原始凭据。

---

# 19. MVP 范围

第一版必须完成：

- [ ] 手工录入/编辑持仓
- [ ] 自动计算总资产与资产大类分布
- [ ] 资产大类目标仓位与偏离
- [ ] 单股/主题集中度风险
- [ ] Gold / Value / Tech 三类评分
- [ ] 评分解释明细
- [ ] 动作状态机
- [ ] 迟滞和冷却期
- [ ] 决策日志
- [ ] 数据更新时间与可信度
- [ ] 至少一个可工作的行情数据 Provider
- [ ] 手工 CSV/JSON fallback
- [ ] 基础回测
- [ ] README + 测试 + 部署说明

第二阶段：

- [ ] 更丰富的中国市场估值数据
- [ ] 自动基金持仓/季报解析
- [ ] 多数据源校验
- [ ] 邮件/Web Push 提醒
- [ ] 相关性与风险贡献分析
- [ ] 更完整的历史回测

第三阶段：

- [ ] 可选 LLM 解释层
- [ ] 自动生成周/月投资复盘
- [ ] 决策质量统计
- [ ] 模型参数版本管理

---

# 20. 状态机

建议状态：

```text
STRONG_ADD_ALLOWED
LIGHT_ADD_ALLOWED
HOLD
DO_NOT_ADD
LIGHT_REDUCE
REDUCE_CONSIDER
OVERWEIGHT
REASSESS_THESIS
LOW_CONFIDENCE
```

优先级：

```text
CRITICAL RISK
> REASSESS_THESIS
> OVERWEIGHT
> LOW_CONFIDENCE
> Opportunity-based state
```

例如：

- Opportunity = 82，但单股已占总资产 12% → `OVERWEIGHT`；
- Opportunity = 78，但 Fundamental = 28 → `REASSESS_THESIS`；
- Opportunity = 70，但数据过期 20 天 → `LOW_CONFIDENCE`。

---

# 21. 示例首页数据

首次启动时可以使用以下手工初始化模板，所有约数要求用户确认：

```json
{
  "baseCurrency": "CNY",
  "holdings": [
    {"name": "现金", "marketValue": 80000, "bucket": "CASH_BONDS"},
    {"name": "股票账户总值", "marketValue": 220000, "bucket": "TECH_GROWTH", "needsBreakdown": true},
    {"name": "债券基金", "marketValue": 160000, "bucket": "CASH_BONDS"},
    {"name": "中欧红利优享灵活配置混合A", "symbol": "004814", "marketValue": 100000, "bucket": "VALUE_DIVIDEND"},
    {"name": "黄金", "marketValue": 20000, "approximate": true, "bucket": "GOLD"},
    {"name": "其他A股科技/A500", "marketValue": 10000, "approximate": true, "bucket": "OTHER"}
  ]
}
```

注意：股票账户需要在 Onboarding 中提醒用户进一步拆分成港股互联网 ETF、先导智能及其他标的，否则集中度分析不准确。

---

# 22. UI 设计原则

视觉目标：专业、克制、信息密度中等。

- 不使用“暴涨”“抄底”“逃顶”等煽动性词汇；
- 颜色只表示状态，不制造情绪；
- 首页先展示风险，再展示机会；
- 每个评分必须可以展开查看计算依据；
- 分数变化要显示“变化原因”，不只显示数字；
- 重要操作建议需显示“由于什么条件触发”；
- 移动端可用。

---

# 23. 测试要求

必须覆盖：

### 单元测试

- 资产分类；
- 总资产/占比计算；
- 估值分归一化；
- 机会评分；
- 风险惩罚；
- 仓位上限；
- Fundamental cap；
- Hysteresis；
- Cooldown；
- 去重；
- Low confidence 降级。

### 集成测试

- 手工录入持仓 → Dashboard 正确更新；
- Provider 更新数据 → ScoreSnapshot 更新；
- 超配标的 → Risk Engine 触发；
- 决策日志写入后 → 冷却期生效；
- 数据源失效 → Manual fallback 可用。

### E2E

至少测试：

1. 新用户初始化；
2. 编辑目标仓位；
3. 拆分股票账户持仓；
4. 查看评分解释；
5. 记录一次“停止加仓”；
6. 运行一次回测。

---

# 24. 验收标准

项目完成时必须满足：

1. `pnpm install && pnpm dev` 可启动；
2. 无需真实 API Key 也能用 Manual Provider 完整体验；
3. 可以录入当前资产并得到正确总资产与占比；
4. 能识别单股/主题过度集中；
5. Gold / Value / Tech 均有可解释评分；
6. 评分变化可追踪；
7. 动作状态不会因 1 天小波动频繁跳变；
8. 决策日志可记录；
9. 能完成至少一种策略回测；
10. 关键逻辑有自动化测试；
11. README 说明如何增加一个新的数据 Provider；
12. 网站不存在自动交易能力。

---

# 25. 建议开发顺序

### Milestone 1 — Portfolio Core

- 数据库
- Holding CRUD
- 资产桶
- Dashboard 分布
- 目标仓位
- 集中度风险

### Milestone 2 — Scoring Engine

- 统一指标模型
- Gold 评分
- Value 评分
- Tech 评分
- Opportunity Score
- Risk Engine

### Milestone 3 — Data Providers

- Manual Provider
- 一个宏观 Provider
- 一个市场行情 Provider
- 数据新鲜度
- Provider 状态页

### Milestone 4 — Decision System

- 状态机
- Hysteresis
- Cooldown
- Signals
- Decision Log

### Milestone 5 — Backtest

- 数据准备
- 基准策略
- 评分策略
- 报告

### Milestone 6 — Polish & Delivery

- 响应式 UI
- E2E
- README
- .env.example
- 部署

---

# 26. 关键产品判断

这个产品最重要的价值不在于“预测下一次上涨”，而在于持续执行以下纪律：

1. 资产桶数量少且明确；
2. 低估只代表“允许提高仓位”，不代表无限补仓；
3. 基本面恶化时，便宜可能是价值陷阱；
4. 单一标的和单一主题有硬上限；
5. 多数时间保持；
6. 只有跨越重要状态区间才操作；
7. 每次决策都留下记录，以便未来验证自己的模型。

如果实现正确，这个网站应当更像一个“个人投资操作系统”，而不是行情看盘软件。

---

# 27. Codex 最终交付清单

完成项目后，请输出：

1. 项目目录树；
2. 技术架构说明；
3. 本地启动命令；
4. 环境变量说明；
5. 数据 Provider 列表；
6. 评分算法说明；
7. 测试覆盖说明；
8. 已知限制；
9. 下一阶段建议；
10. 一份可以直接运行的完整代码库。

**优先级：可运行 > 可解释 > 可扩展 > 视觉炫技。**
