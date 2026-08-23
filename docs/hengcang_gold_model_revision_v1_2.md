# 衡仓（HengCang）
# 《黄金评分模型与“基本面恶化”规则修订 v1.2》

**适用仓库**：`attention-ai-yee/hengcang`  
**目标分支**：`main`  
**用途**：直接交给 Codex 修改现有评分模型。  
**修订范围**：仅调整黄金 `GOLD` 的评分语义、宏观支柱、熔断规则、状态输出和测试；股票/指数资产原有基本面熔断继续保留。  
**核心目标**：避免“实际利率较高”直接触发“投资逻辑需要重新评估”，同时保留黄金宏观逆风时的增配约束。

---

## 1. 当前问题

当前黄金使用三支柱模型：

```text
OpportunityScore =
    Cheapness × 0.50
  + Fundamental × 0.30
  + Trend × 0.20
```

黄金 `Fundamental` 当前由：

```text
实际利率        40%
美元            30%
ETF Flow        20%
央行购金        10%
```

组成。

现有风险规则：

```text
FundamentalScore < 35
且 FundamentalCoverage >= 0.60
→ REASSESS_THESIS
→ allowAdd = false
→ immediate = true
```

该规则适合盈利、ROE、营收等公司/权益基本面指标。

黄金没有企业盈利、ROE、现金流等经营基本面。当前黄金这一支柱实际衡量的是：

```text
宏观环境对黄金的支持程度
```

因此：

```text
高实际利率
```

应解释为：

```text
黄金机会成本较高 / 宏观逆风
```

不应直接解释为：

```text
黄金投资逻辑失效
```

---

# 2. v1.2 核心修改

黄金模型继续保留：

```text
价格吸引力 50%
宏观支持度 30%
趋势       20%
```

内部为了减少数据库和 API 改动，仍允许使用：

```ts
cheapnessScore
fundamentalScore
trendScore
```

字段名。

但展示语义改为：

```text
GOLD.cheapnessScore   -> 价格吸引力
GOLD.fundamentalScore -> 宏观支持度
GOLD.trendScore       -> 趋势
```

其他资产继续显示：

```text
便宜程度
基本面
趋势
```

---

# 3. 黄金不再触发通用 Fundamental Circuit Breaker

修改：

```text
src/domain/scoring/engine.ts
```

当前通用逻辑：

```ts
if (
  fundamentalScore !== null &&
  fundamentalCoverage >= mediumCoverage &&
  fundamentalScore < fundamentalCircuitBreaker
) {
  return REASSESS_THESIS;
}
```

改为：

```ts
if (
  bucket !== "GOLD" &&
  fundamentalScore !== null &&
  fundamentalCoverage >= mediumCoverage &&
  fundamentalScore < fundamentalCircuitBreaker
) {
  return REASSESS_THESIS;
}
```

`applyRiskRules()` 增加：

```ts
bucket: ScorableAssetBucket
```

参数。

调用处：

```ts
applyRiskRules({
  bucket: input.bucket,
  ...
})
```

---

# 4. 新增黄金“宏观逆风”规则

黄金新增单独阈值：

```text
goldMacroHeadwind = 35
```

规则：

```text
如果：
GOLD MacroSupportScore < 35
且 coverage >= 0.60

则：
state = DO_NOT_ADD
allowAdd = false
forceSell = false
immediate = false
```

输出原因：

```text
黄金宏观支持度偏低，当前实际利率、美元或资金流环境对增配不利；停止新增，继续观察宏观方向。
```

该状态：

```text
不进入 REASSESS_THESIS
不要求卖出
不立即覆盖三日确认机制
```

---

# 5. 状态优先级

黄金最终优先级：

```text
OVERWEIGHT
>
LOW_CONFIDENCE
>
GOLD_MACRO_HEADWIND（映射为 DO_NOT_ADD）
>
OpportunityScoreState
```

股票/权益继续：

```text
REASSESS_THESIS
>
OVERWEIGHT
>
LOW_CONFIDENCE
>
OpportunityScoreState
```

为保持状态机简单，v1.2 暂不新增：

```text
MACRO_HEADWIND
```

枚举。

UI 根据：

```text
bucket === GOLD
state === DO_NOT_ADD
```

以及原因字段展示：

```text
宏观逆风，停止新增
```

---

# 6. 黄金宏观支柱重新定义

当前权重：

```text
实际利率水平 40%
美元水平     30%
ETF Flow    20%
央行购金    10%
```

调整为：

```text
实际利率绝对水平       25%
实际利率 3M 变化       15%
美元绝对水平           20%
美元 3M 变化           10%
黄金 ETF 3M Flow       15%
央行购金需求           15%
```

合计：

```text
100%
```

原因：

黄金既受宏观变量当前水平影响，也受这些变量的边际变化方向影响。

---

# 7. default-config.json 修改

修改：

```text
src/domain/scoring/default-config.json
```

建议配置版本：

```json
{
  "version": 2
}
```

阈值增加：

```json
{
  "thresholds": {
    "strongAdd": 75,
    "lightAdd": 60,
    "hold": 40,
    "doNotAdd": 25,
    "fundamentalCircuitBreaker": 35,
    "goldMacroHeadwind": 35
  }
}
```

GOLD：

```json
{
  "GOLD": {
    "cheapness": {
      "longTermPricePosition": 0.40,
      "distanceFromMa200": 0.35,
      "momentumCrowding": 0.25
    },
    "fundamental": {
      "realYieldLevel": 0.25,
      "realYieldChange3m": 0.15,
      "dollarLevel": 0.20,
      "dollarChange3m": 0.10,
      "etfFlow": 0.15,
      "centralBankDemand": 0.15
    }
  }
}
```

---

# 8. 实际利率水平评分

数据：

```text
REAL_YIELD_10Y
FRED DFII10
```

规则保持：

```text
LOWER_IS_BETTER
```

例如当前实际利率处于自身 5 年 96% 分位：

```text
score ≈ 4
```

含义：

```text
当前实际利率绝对水平对黄金明显不利
```

这项只占：

```text
25%
```

---

# 9. 实际利率 3M 变化评分

不新增外部 API。

从已有：

```text
REAL_YIELD_10Y MetricSeries
```

派生：

```text
RealYieldChange3M(t) =
RealYield(t) - RealYield(t - ~90 calendar days)
```

方向：

```text
LOWER_IS_BETTER
```

解释：

```text
负值越大
→ 实际利率下降越明显
→ 黄金宏观环境边际改善
→ 得分越高
```

例：

```text
2.40% -> 2.10%
Change = -0.30pct
```

比：

```text
2.10% -> 2.40%
Change = +0.30pct
```

得到更高分。

---

# 10. 3M Change Series 派生函数

建议新增：

```text
src/domain/scoring/series-transforms.ts
```

函数：

```ts
export function deriveChangeSeries(
  input: MetricSeries,
  lookbackDays: number,
): MetricSeries
```

算法：

对历史每个点 `T`：

```text
targetDate = T - lookbackDays
```

选择：

```text
asOf <= targetDate
```

中最近的一条作为基准点。

计算：

```text
change = current.value - previous.value
```

`availableAt`：

```text
max(current.availableAt, previous.availableAt)
```

保持：

```text
quality = worse(current.quality, previous.quality)
```

来源：

```text
${input.source}-derived-change-${lookbackDays}d
```

不得使用未来点插值。

---

# 11. 美元绝对水平评分

数据：

```text
DOLLAR_INDEX
FRED DTWEXBGS
```

规则：

```text
LOWER_IS_BETTER
```

当前美元位于自身历史低位：

```text
得分高
```

当前美元位于历史高位：

```text
得分低
```

权重：

```text
20%
```

---

# 12. 美元 3M 变化评分

派生：

```text
DollarChange3M(t) =
DollarIndex(t) - DollarIndex(t - ~90 days)
```

方向：

```text
LOWER_IS_BETTER
```

美元过去三个月下跌：

```text
高分
```

美元过去三个月上涨：

```text
低分
```

权重：

```text
10%
```

---

# 13. ETF Flow

继续使用现有：

```text
GOLD_ETF_FLOW_3M
```

规则：

```text
HIGHER_IS_BETTER
```

权重从：

```text
20%
```

调整为：

```text
15%
```

当前国内黄金 ETF Flow 代理保持：

```text
quality = PARTIAL
confidence ceiling = MEDIUM
```

页面必须显示：

```text
国内黄金 ETF 资金流代理
```

---

# 14. 央行购金

权重从：

```text
10%
```

调整为：

```text
15%
```

当前自动数据缺失时：

```text
score = null
```

继续由：

```text
combineComponents()
```

按剩余有效权重重新归一。

禁止填中性常数。

---

# 15. 缺失数据后的重归一示例

如果央行购金缺失：

有效权重：

```text
25 + 15 + 20 + 10 + 15 = 85
```

实际利率水平最终权重：

```text
25 / 85 = 29.4%
```

实际利率变化：

```text
15 / 85 = 17.6%
```

美元水平：

```text
20 / 85 = 23.5%
```

美元变化：

```text
10 / 85 = 11.8%
```

ETF Flow：

```text
15 / 85 = 17.6%
```

---

# 16. 新黄金 Macro Support 计算

伪代码：

```ts
function calculateGold(input: GoldInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.GOLD;

  const realYieldChange3m = deriveChangeSeries(input.realYield, 90);
  const dollarChange3m = deriveChangeSeries(input.dollarIndex, 90);

  const macroSupport = combineComponents({
    realYieldLevel: scoreHistoricalMetric(
      input.realYield,
      weights.fundamental.realYieldLevel,
      "LOWER_IS_BETTER",
      input.asOf,
    ),

    realYieldChange3m: scoreHistoricalMetric(
      realYieldChange3m,
      weights.fundamental.realYieldChange3m,
      "LOWER_IS_BETTER",
      input.asOf,
    ),

    dollarLevel: scoreHistoricalMetric(
      input.dollarIndex,
      weights.fundamental.dollarLevel,
      "LOWER_IS_BETTER",
      input.asOf,
    ),

    dollarChange3m: scoreHistoricalMetric(
      dollarChange3m,
      weights.fundamental.dollarChange3m,
      "LOWER_IS_BETTER",
      input.asOf,
    ),

    etfFlow: ...,

    centralBankDemand: ...,
  });

  return {
    cheapness,
    fundamental: macroSupport,
    trend,
  };
}
```

---

# 17. Opportunity Score 保持不变

黄金仍使用：

```text
OpportunityScore =
    PriceAttractiveness × 0.50
  + MacroSupport × 0.30
  + Trend × 0.20
```

不调整总权重。

---

# 18. 黄金最终决策流程

```text
计算价格吸引力
      ↓
计算宏观支持度
      ↓
计算趋势
      ↓
OpportunityScore
      ↓
仓位上限检查
      ↓
Confidence 检查
      ↓
MacroSupport < 35 ?
      ↓
是 -> DO_NOT_ADD
否 -> OpportunityScore 状态
      ↓
3日确认
      ↓
最终状态
```

---

# 19. 典型案例 A：高实际利率，但正在下降

假设：

```text
实际利率水平得分      5
实际利率3M变化得分   85
美元水平得分         75
美元3M变化得分       80
ETF Flow             45
央行购金             Missing
```

有效权重归一后：

```text
MacroSupport ≈ 52
```

含义：

```text
实际利率绝对水平仍明显不利，
但实际利率和美元的边际方向改善，
整体宏观环境为中性偏有利。
```

不会触发：

```text
REASSESS_THESIS
```

---

# 20. 典型案例 B：高实际利率且继续上升

```text
实际利率水平       5
实际利率3M变化    10
美元水平          30
美元3M变化        20
ETF Flow          25
央行购金          Missing
```

可能得到：

```text
MacroSupport = 15–25
```

结果：

```text
DO_NOT_ADD
```

解释：

```text
宏观逆风较强，停止新增。
```

---

# 21. 典型案例 C：宏观支持较弱但价格很便宜

```text
PriceAttractiveness = 85
MacroSupport         = 32
Trend                = 60
```

原始 Opportunity：

```text
85×0.5 + 32×0.3 + 60×0.2
= 64.1
```

正常机会分可能进入：

```text
LIGHT_ADD_ALLOWED
```

但黄金宏观逆风闸门覆盖：

```text
MacroSupport < 35
→ DO_NOT_ADD
```

---

# 22. 典型案例 D：宏观支持好但价格非常拥挤

```text
PriceAttractiveness = 20
MacroSupport         = 80
Trend                = 90
```

Opportunity：

```text
20×0.5 + 80×0.3 + 90×0.2
= 52
```

结果：

```text
HOLD
```

---

# 23. Confidence 规则保持

继续使用当前：

```text
coverage >= 0.80
→ HIGH eligible

0.60–0.80
→ MEDIUM

<0.60
→ LOW
```

以及：

```text
PARTIAL
→ confidence ceiling MEDIUM
```

---

# 24. UI 修改

评分页中 GOLD：

当前：

```text
便宜程度
基本面
趋势
```

改显示：

```text
价格吸引力
宏观支持度
趋势
```

Tooltip：

### 价格吸引力

```text
衡量黄金当前价格位置和拥挤程度。分数越高，当前价格位置越适合增加配置。
```

### 宏观支持度

```text
衡量实际利率、美元、ETF 资金流和央行需求对黄金的支持程度。低分代表宏观逆风，不表示黄金长期配置逻辑失效。
```

### 趋势

```text
衡量中长期价格趋势和动量状态。
```

---

# 25. “重新评估投资逻辑”文案限制

以下文案：

```text
基本面恶化
重新评估投资逻辑
投资逻辑可能失效
```

仅允许用于：

```text
VALUE_DIVIDEND
TECH_GROWTH
BROAD_EQUITY
```

且满足：

```text
FundamentalScore < fundamentalCircuitBreaker
Coverage >= mediumCoverage
```

GOLD 禁止使用上述文案。

黄金低宏观支持度统一使用：

```text
宏观逆风较强
当前不支持新增
继续观察实际利率、美元和资金流方向
```

---

# 26. 数据状态页

黄金展开显示：

```text
宏观支持度

实际利率水平
实际利率 3M 变化
美元指数水平
美元指数 3M 变化
国内黄金 ETF 3M Flow
央行购金需求
```

每项继续显示：

```text
Raw Value
Historical Percentile
Score
Provider
Quality
As Of
Confidence
```

---

# 27. 需要修改的文件

必改：

```text
src/domain/scoring/default-config.json
src/domain/scoring/config.ts
src/domain/scoring/models.ts
src/domain/scoring/engine.ts
src/domain/scoring/types.ts

app/(product)/scores/page.tsx
src/components/score-explanation-tooltip.tsx

tests/unit/scoring-models.test.ts
tests/unit/scoring.test.ts
```

建议新增：

```text
src/domain/scoring/series-transforms.ts
tests/unit/series-transforms.test.ts
tests/unit/gold-scoring-v1-2.test.ts
```

---

# 28. config.ts

`ScoringConfig.thresholds` 增加：

```ts
goldMacroHeadwind: number;
```

校验：

```ts
if (
  goldMacroHeadwind < 0 ||
  goldMacroHeadwind > 100
) {
  throw new Error("黄金宏观逆风阈值必须位于 0–100");
}
```

---

# 29. engine.ts 推荐实现

```ts
export function applyRiskRules(input: {
  bucket: ScorableAssetBucket;
  opportunityScore: number | null;
  fundamentalScore: number | null;
  fundamentalCoverage?: number;
  confidence: Confidence;
  currentWeightBps?: number;
  positionLimitBps?: number;
  config?: ScoringConfig;
}) {
  const config = input.config ?? DEFAULT_SCORING_CONFIG;
  const coverage = input.fundamentalCoverage ?? 1;

  if (
    input.bucket !== "GOLD" &&
    input.fundamentalScore !== null &&
    coverage >= config.history.mediumCoverage &&
    input.fundamentalScore < config.thresholds.fundamentalCircuitBreaker
  ) {
    return {
      state: "REASSESS_THESIS",
      allowAdd: false,
      forceSell: false,
      immediate: true,
      reasons: ["基本面分过低，暂停新增并重新评估投资逻辑"],
    };
  }

  if (
    input.currentWeightBps !== undefined &&
    input.positionLimitBps !== undefined &&
    input.currentWeightBps > input.positionLimitBps
  ) {
    return {
      state: "OVERWEIGHT",
      allowAdd: false,
      forceSell: false,
      immediate: true,
      reasons: ["当前仓位超过适用上限，停止新增"],
    };
  }

  if (
    input.opportunityScore === null ||
    input.fundamentalScore === null ||
    input.confidence === "LOW"
  ) {
    return {
      state: "LOW_CONFIDENCE",
      allowAdd: false,
      forceSell: false,
      immediate: true,
      reasons: ["数据可信度不足，禁止输出增配状态"],
    };
  }

  if (
    input.bucket === "GOLD" &&
    coverage >= config.history.mediumCoverage &&
    input.fundamentalScore < config.thresholds.goldMacroHeadwind
  ) {
    return {
      state: "DO_NOT_ADD",
      allowAdd: false,
      forceSell: false,
      immediate: false,
      reasons: [
        "黄金宏观支持度偏低，当前停止新增；继续观察实际利率、美元和资金流方向"
      ],
    };
  }

  // 继续原 OpportunityScore / MEDIUM confidence 逻辑
}
```

---

# 30. series-transforms 测试

## Case 1

```text
Jan 1 Real Yield = 2.40
Apr 1 Real Yield = 2.10
```

预期：

```text
Change3M = -0.30
```

## Case 2

没有恰好 90 天前的 observation：

```text
选择 targetDate 之前最近的一条
```

禁止选择 targetDate 之后的数据。

## Case 3

派生 observation：

```text
availableAt = max(current.availableAt, previous.availableAt)
```

---

# 31. Gold scoring 测试

## Test A：低 MacroSupport 不触发 REASSESS_THESIS

```text
bucket = GOLD
MacroSupport = 30
coverage = 0.85
```

预期：

```text
state = DO_NOT_ADD
allowAdd = false
immediate = false
```

## Test B：权益基本面低仍触发 REASSESS_THESIS

```text
bucket = VALUE_DIVIDEND
Fundamental = 30
coverage = 0.85
```

预期：

```text
REASSESS_THESIS
```

## Test C：黄金宏观分 40

```text
MacroSupport = 40
OpportunityScore = 70
Confidence = HIGH
```

预期继续走：

```text
LIGHT_ADD_ALLOWED
```

## Test D：黄金超配优先

```text
MacroSupport = 20
currentWeight > limit
```

预期：

```text
OVERWEIGHT
```

## Test E：黄金 LOW_CONFIDENCE

```text
MacroSupport = 20
coverage = 0.50
confidence = LOW
```

预期：

```text
LOW_CONFIDENCE
```

---

# 32. 回测要求

新增的：

```text
RealYieldChange3M
DollarChange3M
```

必须严格使用：

```text
availableAt <= evaluationDate
```

派生 3M Change 时，历史基准点也必须在评价日当时已经可用。

---

# 33. 模型版本

建议：

```text
Scoring Config version = 2
```

Score Snapshot：

```text
componentsJson.modelVersion
```

保存新版本。

---

# 34. 验收标准

- [ ] GOLD 不再触发 `fundamentalCircuitBreaker`
- [ ] GOLD MacroSupport < 35 时输出 `DO_NOT_ADD`
- [ ] 黄金宏观逆风不使用“重新评估投资逻辑”文案
- [ ] 黄金 MacroSupport 增加实际利率 3M 变化
- [ ] 黄金 MacroSupport 增加美元 3M 变化
- [ ] 3M Change 历史计算无前视
- [ ] 实际利率水平权重由 40% 调整为 25%
- [ ] 央行购金权重提高到 15%
- [ ] ETF Flow 权重调整为 15%
- [ ] 央行购金缺失时正常重归一
- [ ] GOLD UI 显示“价格吸引力 / 宏观支持度 / 趋势”
- [ ] ETF Flow 明确显示为国内黄金 ETF 代理
- [ ] 权益资产原有 `REASSESS_THESIS` 逻辑仍正常
- [ ] OVERWEIGHT 仍优先于黄金宏观逆风
- [ ] LOW_CONFIDENCE 时不输出宏观逆风判断
- [ ] MEDIUM Confidence 原有强动作限制继续有效
- [ ] 新测试全部通过
- [ ] 原有测试全部通过

---

# 35. 最终模型解释

v1.2 后黄金评分回答三个问题：

```text
价格吸引力
→ 当前黄金价格位置是否适合继续增加配置？

宏观支持度
→ 实际利率、美元、资金流和央行需求当前是否支持黄金？

趋势
→ 黄金当前中长期价格趋势是否健康？
```

最终：

```text
增配吸引力
=
价格吸引力 50%
+
宏观支持度 30%
+
趋势 20%
```

宏观支持度很低时：

```text
停止新增
```

黄金长期配置逻辑不会因为单一宏观指标处于不利区间自动进入：

```text
REASSESS_THESIS
```
