# 模型修订：趋势 v1.3 与科技 v1.4

本文件补齐代码中已实现、但 v1.0/v1.1 规格文档尚未覆盖的两次模型修订，以及黄金 v1.2 的 WGC 接入与全局数据新鲜度规则。实现位置以 `src/domain/scoring/` 为准。

## 趋势模型 v1.3（`models.ts` `calculateTrend`）

v1.0 的“价格是否在 MA200 上方 / 均线是否多头排列”是二值开关（跨越当天分数从 0 跳到 100）。v1.3 改为连续线性带，保持可手算：

| 组件 | 权重 | 口径 |
|---|---:|---|
| `ma200` 长期趋势 | 40% | 价格相对 MA200 偏离，±5% 带宽线性插值（偏离 0% = 50 分，+5% = 100 分） |
| `maAlignment` 均线结构 | 30% | MA20/MA60（±5% 带）35% + MA60/MA200（±10% 带）65% |
| `momentum6m` 6 个月动量 | 30% | 仍为历史滚动百分位，越高越强 |

- `bandScore(distancePct, halfBandPct) = clamp(50 + distancePct / halfBandPct × 50, 0, 100)`。
- 价格恰等于 MA200 时得 50 分（v1.0 为 0 分），避免“贴着均线”产生全篇切换。
- 纯价格技术特征的置信度可继承主行情来源；手工价格为 LOW。

## 科技模型 v1.4 Route B（`models.ts` `calculateTechGrowth`）

v1.4 删除前瞻预测数据（`PE_FORWARD` 生产者已移除），改用已实现的 TTM 基本面：

| 支柱 | 组件与权重 |
|---|---|
| 便宜程度 | `PE_TTM` 45%、`PS` 25%、`PEG_TTM`（= PE_TTM ÷ 已实现盈利增速）30% |
| 基本面 | 已实现盈利增长 55%、营收增长 45% |

- `PEG_TTM` 由 `series-transforms.ts` 的确定性变换生成，不做分析师预测。
- 旧库若完全没有 `PE_TTM` 历史，`PE_FORWARD` 仅作为遗留回退口径（`automatic-data-refresh-service.ts`），新数据不再生产。
- 数据质量：聚合/派生代理数据最高 MEDIUM，`VALID` 且历史 ≥3 个完整日历年才可能 HIGH。

## 黄金 v1.2 与 WGC 流量（`models.ts`、`providers/wgc.ts`）

- 黄金基本面改称“宏观支持度”：实际利率水平/3M 变化、美元指数水平/3M 变化、全球黄金 ETF 流量（WGC 月度，15%）、央行购金需求（15%）。
- 宏观支持度低只触发“停止新增”（DO_NOT_ADD），不触发 `REASSESS_THESIS`；`OVERWEIGHT` / `LOW_CONFIDENCE` 仍优先。
- 黄金 ETF 流量优先使用 WGC Goldhub 全球三月滚动净流入（官方月度修订口径，`VALID`）；请求失败或序列过短时回退国内黄金 ETF 份额/NAV 代理并标 `PARTIAL`。

## 数据新鲜度规则（v1.5 补充）

- 默认配置新增 `history.maxObservationAgeDays = 180`。
- 指标最新观察的“可见时间”取 `max(asOf, availableAt)`（报告期早于公告日属于正常披露滞后，不能被误判为陈旧）。
- 超过 180 天时只把该组件 confidence 降为 LOW，分数不变；`LOW_CONFIDENCE` 状态会禁止输出增配。
- 覆盖范围：估值、基本面、趋势、宏观全部走 `scoreHistoricalMetric` 的指标。

## 状态确认与冷却（本次修复）

- 候选状态要求最近 3 个**交易日**连续保持：由 `metric_observations` 的 `PRICE_CLOSE` 日期构建交易日历校验相邻性；断档、周末、跨月不再凑数。
- 全量回填的历史快照（月度采样）不套用逐日确认（`skipConfirmation`），避免历史状态永远无法确认。
- 冷却按日期比较：决策当天即开始抑制同方向建议，7 个自然日后恢复。
