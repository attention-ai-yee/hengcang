# 衡仓（HengCang）资产评分引擎计算规范 v1.0

> 用途：直接交给 Codex / 程序实现。  
> 目标：把“当前资产是否值得增加配置”转换为可重复、可解释、可测试的 0–100 分评分。  
> 原则：评分只提供决策支持；程序不自动交易。

---

## 1. 评分对象

v1 对以下 4 类资产计算“配置机会分”：

1. `GOLD`：黄金
2. `VALUE_DIVIDEND`：红利 / 价值
3. `TECH_GROWTH`：科技 / 成长
4. `BROAD_EQUITY`：宽基权益（如中证 A500、沪深 300、标普 500 等）

`CASH_BONDS`（现金 / 债券）不计算配置机会分，只显示：

- 当前金额
- 当前占比
- 可用流动性
- 当前收益率（若可得）
- 预留资金占用情况

---

## 2. 统一评分方向

所有资产的最终分数统一为：

```text
0   = 极低吸引力
50  = 中性
100 = 极高吸引力
```

程序页面只使用这一种方向，避免“某些指标分数越高越贵、某些越高越便宜”的混乱。

最终核心分数：

```text
OpportunityScore =
    0.50 * CheapnessScore
  + 0.30 * FundamentalScore
  + 0.20 * TrendScore
```

其中：

- `CheapnessScore`：便宜程度，越高越便宜
- `FundamentalScore`：基本面健康度，越高越健康
- `TrendScore`：趋势健康度，越高越强
- 所有子分数范围均为 `[0, 100]`

最终结果四舍五入到 1 位小数。

---

## 3. 分位数标准化函数

大部分指标统一使用“历史滚动百分位”转换为 0–100 分。

### 3.1 默认观察窗口

优先级：

```text
5 年日频/周频历史
↓
历史不足 5 年时使用全部可用历史
↓
少于 3 年时 confidence 降为 LOW
```

财务指标按季度或年度数据计算历史百分位。

### 3.2 越高越有吸引力的指标

例如股息率、ROE、盈利增速：

```text
score = percentile_rank(current_value, historical_values) * 100
```

例：

当前股息率处于过去 5 年的 82% 分位：

```text
score = 82
```

### 3.3 越低越有吸引力的指标

例如 PE、PB、PS、实际利率：

```text
score = (1 - percentile_rank(current_value, historical_values)) * 100
```

例：

当前 PE 处于历史 20% 分位：

```text
score = 80
```

### 3.4 缺失数据

单个指标缺失时：

1. 去掉该指标；
2. 对剩余指标权重重新归一化；
3. 记录 `missing_metrics`；
4. 缺失关键指标过多时降低 `confidence`。

若某个子评分可用权重低于原设计权重的 60%，该子评分标记为 `LOW_CONFIDENCE`。

---

# 4. 红利 / 价值（VALUE_DIVIDEND）

## 4.1 CheapnessScore

```text
CheapnessScore =
    0.35 * PE_Cheapness
  + 0.25 * PB_Cheapness
  + 0.40 * DividendYield_Attractiveness
```

计算方式：

```text
PE_Cheapness
= 100 - PE 历史百分位

PB_Cheapness
= 100 - PB 历史百分位

DividendYield_Attractiveness
= 股息率历史百分位
```

### 示例

```text
PE 历史分位：30%
PB 历史分位：40%
股息率历史分位：80%

PE_Cheapness = 70
PB_Cheapness = 60
DividendYield = 80

CheapnessScore
= 70*0.35 + 60*0.25 + 80*0.40
= 71.5
```

---

## 4.2 FundamentalScore

v1 使用 3 项：

```text
FundamentalScore =
    0.40 * EarningsGrowthScore
  + 0.30 * ROEScore
  + 0.30 * DividendStabilityScore
```

### EarningsGrowthScore

优先使用未来 12 个月一致预期盈利增速；没有一致预期时使用最近 4 季度同比盈利增速。

```text
score = 历史百分位
```

### ROEScore

使用当前 ROE 相对自身历史位置：

```text
score = ROE 历史百分位
```

### DividendStabilityScore

建议：

```text
基础分 = 100

若最近 5 年出现 1 次明显减配/减分红：-20
若出现 2 次：-40
若连续 3 年以上稳定或增长：+0
若当前派息率明显超过可持续盈利/现金流：最多 40
```

最终 clamp 到 `[0, 100]`。

对于基金（如 004814）无法直接使用基金自身 ROE 时：

```text
FundamentalScore =
    0.50 * 重仓组合盈利健康度
  + 0.25 * 基金经理/策略稳定度
  + 0.25 * 风格与持仓稳定度
```

若这些数据暂时无法自动获得，允许手工录入 `fundamental_override`。

---

## 4.3 TrendScore

统一趋势模型：

```text
TrendScore =
    MA200Score
  + MAAlignmentScore
  + Momentum6MScore
```

其中：

### MA200Score

```text
价格 > MA200  -> 40
价格 <= MA200 -> 0
```

### MAAlignmentScore

```text
MA20 > MA60 > MA200 -> 30
MA60 > MA200        -> 20
MA60 <= MA200       -> 0
```

### Momentum6MScore

对近 6 个月总收益率做滚动 5 年百分位：

```text
Momentum6MScore = percentile * 30
```

总分范围 `[0,100]`。

---

# 5. 科技 / 成长（TECH_GROWTH）

## 5.1 CheapnessScore

科技不能只使用 PE，因此 v1：

```text
CheapnessScore =
    0.40 * ForwardPE_Cheapness
  + 0.20 * PS_Cheapness
  + 0.40 * GrowthAdjustedValuation
```

### ForwardPE_Cheapness

```text
100 - Forward PE 历史百分位
```

### PS_Cheapness

```text
100 - PS 历史百分位
```

### GrowthAdjustedValuation

优先计算 PEG：

```text
PEG = ForwardPE / ExpectedEarningsGrowthPercent
```

例：

```text
Forward PE = 30
预计盈利增速 = 25%
PEG = 1.2
```

然后：

```text
GrowthAdjustedValuation
= 100 - PEG 历史百分位
```

特殊情况：

```text
预计盈利增速 <= 0
=> GrowthAdjustedValuation = min(30, ForwardPE_Cheapness)
```

避免“盈利负增长但估值看起来便宜”得到高分。

---

## 5.2 FundamentalScore

```text
FundamentalScore =
    0.40 * EarningsGrowthScore
  + 0.30 * RevenueGrowthScore
  + 0.30 * EarningsRevisionScore
```

### EarningsGrowthScore

未来 12M 盈利增长历史百分位。

### RevenueGrowthScore

未来 12M / 最近 4 季度营收增长历史百分位。

### EarningsRevisionScore

如果有分析师一致预期：

```text
revision = 当前 FY1 EPS 预测 / 90 天前 FY1 EPS 预测 - 1
```

将 revision 做历史百分位映射。

如果没有该数据：

```text
FundamentalScore =
    0.55 * EarningsGrowthScore
  + 0.45 * RevenueGrowthScore
```

---

## 5.3 TrendScore

与红利统一：

```text
TrendScore =
    MA200Score
  + MAAlignmentScore
  + Momentum6MScore
```

---

# 6. 宽基权益（BROAD_EQUITY）

## 6.1 CheapnessScore

```text
CheapnessScore =
    0.40 * PE_Cheapness
  + 0.30 * PB_Cheapness
  + 0.30 * EquityRiskPremiumScore
```

### EquityRiskPremiumScore

建议：

```text
EarningsYield = 1 / PE
ERP = EarningsYield - RiskFreeYield
```

ERP 越高越有吸引力：

```text
EquityRiskPremiumScore = ERP 历史百分位
```

若无法获得 ERP：

```text
CheapnessScore =
    0.60 * PE_Cheapness
  + 0.40 * PB_Cheapness
```

---

## 6.2 FundamentalScore

```text
FundamentalScore =
    0.60 * IndexEarningsGrowthScore
  + 0.40 * EarningsRevisionScore
```

没有盈利修正数据时：

```text
FundamentalScore = IndexEarningsGrowthScore
```

---

## 6.3 TrendScore

沿用统一趋势模型。

---

# 7. 黄金（GOLD）

黄金单独计算，因为黄金没有 PE、PB、盈利和股息。

黄金仍输出：

- `CheapnessScore`
- `FundamentalScore`
- `TrendScore`
- `OpportunityScore`

但含义调整如下。

## 7.1 CheapnessScore

这里代表“价格是否拥挤 / 是否适合追买”。

```text
CheapnessScore =
    0.40 * LongTermPricePosition
  + 0.35 * DistanceFromMA200Score
  + 0.25 * MomentumCrowdingScore
```

### LongTermPricePosition

当前黄金价格在过去 5 年价格历史分位：

```text
LongTermPricePosition =
100 - price_percentile
```

### DistanceFromMA200Score

计算：

```text
distance = Price / MA200 - 1
```

使用过去 5 年 `distance` 的历史百分位：

```text
DistanceFromMA200Score =
100 - distance_percentile
```

距离长期均线越远，追买吸引力越低。

### MomentumCrowdingScore

使用 3 个月收益率的历史百分位：

```text
MomentumCrowdingScore =
100 - 3M_return_percentile
```

该分数只反映“拥挤程度”，不会直接否定趋势。

---

## 7.2 FundamentalScore（黄金宏观环境）

```text
FundamentalScore =
    0.40 * RealYieldScore
  + 0.30 * DollarScore
  + 0.20 * ETFFlowScore
  + 0.10 * CentralBankDemandScore
```

### RealYieldScore

实际利率越低，对黄金越友好：

```text
RealYieldScore =
100 - 实际利率历史百分位
```

推荐指标：

```text
US 10Y Real Yield
```

### DollarScore

美元越弱，对黄金越友好：

```text
DollarScore =
100 - 美元指数历史百分位
```

### ETFFlowScore

优先使用黄金 ETF 过去 3 个月累计净流入的历史百分位：

```text
ETFFlowScore = flow_percentile
```

没有 ETF 流量数据时，移除该项并重新归一权重。

### CentralBankDemandScore

如果只能获得季度数据：

```text
央行净购金处于历史高位 -> 高分
净购金趋弱             -> 中低分
```

可用历史百分位。

如果数据无法稳定获取，允许手工输入 0–100，默认不参与评分。

---

## 7.3 TrendScore

```text
TrendScore =
    MA200Score
  + MAAlignmentScore
  + Momentum6MScore
```

与其他资产统一。

这样会出现一种合理情况：

```text
黄金 Cheapness = 30
Fundamental = 90
Trend = 95

Opportunity
= 30*0.5 + 90*0.3 + 95*0.2
= 61
```

解释：

```text
趋势和宏观环境很强，但价格已经比较拥挤。
状态：继续持有 / 小幅增配，不适合大幅追高。
```

---

# 8. 最终机会分

所有可评分资产：

```text
rawOpportunity =
    CheapnessScore * 0.50
  + FundamentalScore * 0.30
  + TrendScore * 0.20
```

然后执行硬规则。

---

# 9. 硬规则（必须在机会分之后执行）

## 9.1 基本面熔断

```text
if FundamentalScore < 35:
    state = REASSESS_THESIS
    allow_add = false
```

无论 CheapnessScore 多高，都不能输出增配建议。

---

## 9.2 单股仓位限制

默认：

```text
single_stock_limit = 8%
```

计算分母使用“可投资资产”。

历史已有仓位超过 8%：

```text
state = OVERWEIGHT
allow_add = false
force_sell = false
```

程序文案：

```text
超配：停止新增，可继续持有；后续通过上涨减仓或新增资金稀释仓位。
```

8% 约束新增仓位，不要求系统强制处理已有仓位。

---

## 9.3 主题 ETF 仓位限制

默认：

```text
thematic_etf_limit = 15%
```

超过后：

```text
allow_add = false
force_sell = false
state = OVERWEIGHT
```

---

## 9.4 数据质量限制

```text
if confidence == LOW:
    STRONG_ADD_ALLOWED 禁用
```

最高只能输出：

```text
HOLD
或
WATCH / LOW_CONFIDENCE
```

---

# 10. 机会分到状态的映射

在没有硬规则覆盖时：

| OpportunityScore | 状态代码 | 中文显示 |
|---:|---|---|
| 75–100 | `STRONG_ADD_ALLOWED` | 明显机会，可考虑增配 |
| 60–74.9 | `LIGHT_ADD_ALLOWED` | 偏有吸引力，可小幅增配 |
| 40–59.9 | `HOLD` | 中性，持有 / 等待 |
| 25–39.9 | `DO_NOT_ADD` | 偏贵或偏弱，停止新增 |
| 0–24.9 | `REDUCE_CONSIDER` | 风险偏高，可考虑降低仓位 |

状态优先级：

```text
REASSESS_THESIS
> OVERWEIGHT
> LOW_CONFIDENCE
> OpportunityScoreState
```

---

# 11. 状态确认 / 防止频繁跳变

v1 只做一个简单规则：

```text
状态跨区间后，连续 3 个交易日保持在新区间才正式切换。
```

例外：

以下事件即时生效：

```text
FundamentalScore < 35
仓位超过硬上限
数据异常/严重过期
```

用户手工记录一次加仓或减仓后：

```text
同方向建议冷却 7 天
```

冷却期间继续更新分数，但不重复提示同方向操作。

---

# 12. 家庭大额支出：可投资资产计算

程序只增加一个输入：

```text
reserved_cash
```

例如计划买车：

```text
reserved_cash = 150000
```

计算：

```text
TotalFinancialAssets = 所有金融资产当前市值之和

InvestableAssets =
    TotalFinancialAssets - reserved_cash
```

要求：

```text
InvestableAssets >= 0
```

### 预留资金如何从资产桶扣除

v1 默认预留资金优先占用：

```text
1. 现金
2. 现金/债券桶
```

例如：

```text
现金 + 债券 = 240000
预留买车 = 150000

可投资的 Cash/Bonds = 90000
```

之后所有投资组合比例使用：

```text
investable_bucket_value / InvestableAssets
```

用户买完车后把 `reserved_cash` 改为 0，系统重新计算。

---

# 13. 当前持仓的初始化逻辑

基于用户当前手工描述，首次录入可提供模板：

```text
现金                     80,000
股票账户当前市值          220,000
债券基金                 160,000
中欧红利A（004814）       100,000
黄金                     20,000+（待确认）
其他科技 / A500          10,000+（待确认）
```

程序必须要求股票账户进一步拆分：

```text
港股互联网 ETF
先导智能
其他股票/ETF
```

否则单股和主题集中度无法准确计算。

---

# 14. 建议的 TypeScript 类型

```ts
type AssetBucket =
  | "GOLD"
  | "VALUE_DIVIDEND"
  | "TECH_GROWTH"
  | "BROAD_EQUITY"
  | "CASH_BONDS"
  | "OTHER";

type Confidence = "HIGH" | "MEDIUM" | "LOW";

type AllocationState =
  | "STRONG_ADD_ALLOWED"
  | "LIGHT_ADD_ALLOWED"
  | "HOLD"
  | "DO_NOT_ADD"
  | "REDUCE_CONSIDER"
  | "OVERWEIGHT"
  | "REASSESS_THESIS"
  | "LOW_CONFIDENCE";

interface ScoreResult {
  bucket: AssetBucket;
  asOf: string;

  cheapnessScore: number | null;
  fundamentalScore: number | null;
  trendScore: number | null;
  opportunityScore: number | null;

  confidence: Confidence;
  state: AllocationState;

  allowAdd: boolean;
  forceSell: false;

  components: Record<string, {
    rawValue: number | null;
    percentile: number | null;
    score: number | null;
    weight: number;
    source: string;
    asOf: string;
  }>;

  reasons: string[];
}
```

---

# 15. 核心计算伪代码

```ts
function calculateOpportunityScore(
  cheapness: number,
  fundamental: number,
  trend: number
): number {
  return round1(
    cheapness * 0.50 +
    fundamental * 0.30 +
    trend * 0.20
  );
}
```

```ts
function getBaseState(score: number): AllocationState {
  if (score >= 75) return "STRONG_ADD_ALLOWED";
  if (score >= 60) return "LIGHT_ADD_ALLOWED";
  if (score >= 40) return "HOLD";
  if (score >= 25) return "DO_NOT_ADD";
  return "REDUCE_CONSIDER";
}
```

```ts
function applyRiskRules(input: {
  opportunityScore: number;
  fundamentalScore: number;
  confidence: Confidence;
  currentWeight: number;
  positionLimit?: number;
}): AllocationState {

  if (input.fundamentalScore < 35) {
    return "REASSESS_THESIS";
  }

  if (
    input.positionLimit !== undefined &&
    input.currentWeight > input.positionLimit
  ) {
    return "OVERWEIGHT";
  }

  if (input.confidence === "LOW") {
    return "LOW_CONFIDENCE";
  }

  return getBaseState(input.opportunityScore);
}
```

---

# 16. 历史百分位函数要求

必须避免未来数据泄漏。

回测日期为 `T` 时：

```text
percentile(current_T)
```

只能使用：

```text
date <= T
```

的历史数据。

禁止使用完整历史样本对过去日期评分。

推荐实现：

```ts
function rollingPercentile(
  current: number,
  historyUpToToday: number[]
): number {
  const valid = historyUpToToday.filter(Number.isFinite);

  if (valid.length === 0) return NaN;

  const lessOrEqual =
    valid.filter(v => v <= current).length;

  return lessOrEqual / valid.length;
}
```

生产版可进一步处理重复值。

---

# 17. 数据更新频率

| 数据类型 | 建议刷新频率 |
|---|---|
| 价格 / 均线 | 每个交易日收盘后 |
| PE / PB / 股息率 | 每日或供应商更新时 |
| 盈利预期 | 每周或每日 |
| 财务报表 | 新财报发布后 |
| 实际利率 / 美元 | 每日 |
| 黄金 ETF 流量 | 每日/周 |
| 央行购金 | 月度/季度 |

每个指标必须保存：

```text
value
as_of
source
```

页面必须显示最后更新时间。

---

# 18. 推荐页面展示

首页每个资产卡片只展示：

```text
科技成长

机会分       71
便宜程度     72
基本面       80
趋势         55

当前状态：
可小幅增配

当前仓位：
24%

目标区间：
20%–40%
```

点击“为什么”后再展开组成指标。

不要在首页堆几十个指标。

---

# 19. 程序必须遵守的决策逻辑

最终流程固定为：

```text
读取数据
  ↓
计算历史百分位
  ↓
计算 Cheapness / Fundamental / Trend
  ↓
计算 OpportunityScore
  ↓
检查基本面熔断
  ↓
检查当前仓位上限
  ↓
检查数据可信度
  ↓
执行 3 日状态确认
  ↓
输出最终状态
```

程序必须区分：

```text
资产值得不值得买
```

和：

```text
当前仓位还能不能继续买
```

例：

```text
先导智能
OpportunityScore = 82
当前仓位 = 12%
单股上限 = 8%

最终状态 = OVERWEIGHT
allowAdd = false
forceSell = false
```

---

# 20. v1 不做的内容

为了保持简单，第一版暂时不加入：

- AI 自动决定买卖金额
- 自动交易
- 高频日内信号
- 复杂期权指标
- 上百个技术指标
- 复杂家庭财务规划
- 精确预测顶部 / 底部
- 过度优化的机器学习模型

第一版目标只有：

> **用少量可解释指标判断“便宜程度、基本面、趋势”，再结合仓位上限输出稳定的配置状态。**

---

# 21. 测试案例

## Case A：科技便宜且基本面好

```text
Cheapness = 80
Fundamental = 85
Trend = 70

Opportunity
= 80*0.5 + 85*0.3 + 70*0.2
= 79.5
```

仓位 20%，上限 40%：

```text
state = STRONG_ADD_ALLOWED
allowAdd = true
```

---

## Case B：单股很便宜但已经超配

```text
Opportunity = 82
Fundamental = 80
CurrentWeight = 12%
SingleStockLimit = 8%
```

结果：

```text
state = OVERWEIGHT
allowAdd = false
forceSell = false
```

---

## Case C：跌很多但基本面恶化

```text
Cheapness = 95
Fundamental = 25
Trend = 20
```

结果：

```text
state = REASSESS_THESIS
allowAdd = false
```

即使价格看起来非常便宜，也暂停补仓。

---

## Case D：黄金趋势强但已经拥挤

```text
Cheapness = 30
Fundamental = 90
Trend = 95

Opportunity = 61
```

结果：

```text
LIGHT_ADD_ALLOWED
```

若黄金仓位已经达到用户设定上限：

```text
OVERWEIGHT / DO_NOT_ADD
```

---

## Case E：计划买车

```text
TotalFinancialAssets = 600000
ReservedCash = 150000

InvestableAssets = 450000
```

若某单股当前市值 50000：

```text
PositionWeight = 50000 / 450000
= 11.11%
```

高于 8% 单股上限：

```text
OVERWEIGHT
```

---

# 22. 验收标准

Codex 完成评分引擎后必须满足：

- [ ] 所有评分范围均为 0–100
- [ ] 高分始终代表更高配置吸引力
- [ ] 4 个可评分资产桶均有独立算法
- [ ] 黄金算法不使用 PE / PB
- [ ] 支持历史滚动百分位
- [ ] 回测中无前视数据
- [ ] 缺失指标能自动重新归一权重
- [ ] 基本面 < 35 时禁止加仓
- [ ] 单股 > 8% 时禁止新增但不强制卖出
- [ ] 主题 ETF > 15% 时禁止新增但不强制卖出
- [ ] 支持 `reserved_cash`
- [ ] 所有仓位比例基于 `InvestableAssets`
- [ ] 状态需要 3 个交易日确认
- [ ] 用户交易后同方向提示有 7 天冷却
- [ ] 每个分数都能展开查看计算依据
- [ ] 每项数据都显示来源和更新时间
- [ ] 单元测试覆盖测试案例 A–E

---

# 23. 默认配置 JSON

程序第一版可以直接把以下内容做成配置文件：

```json
{
  "scoreWeights": {
    "cheapness": 0.50,
    "fundamental": 0.30,
    "trend": 0.20
  },
  "thresholds": {
    "strongAdd": 75,
    "lightAdd": 60,
    "hold": 40,
    "doNotAdd": 25,
    "fundamentalCircuitBreaker": 35
  },
  "positionLimits": {
    "singleStock": 0.08,
    "thematicETF": 0.15
  },
  "signalRules": {
    "confirmationTradingDays": 3,
    "cooldownDays": 7
  },
  "history": {
    "preferredYears": 5,
    "minimumYearsForMediumConfidence": 3
  },
  "portfolio": {
    "baseCurrency": "CNY",
    "reservedCash": 0
  }
}
```

---

# 24. 最终实现原则

第一版评分引擎应优先满足：

```text
可解释
> 稳定
> 可测试
> 可修改
> 复杂度
```

用户看到任何“71 分”“82 分”时，都必须能够点开看到：

```text
用了哪些指标
每项是多少
历史百分位是多少
权重是多少
数据日期是什么
最终为什么得到这个状态
```

这样评分才具备长期使用价值。
