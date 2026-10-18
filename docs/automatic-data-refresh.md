# 自动数据刷新

自动刷新主链路为：

```text
Provider API → Canonical Observation → SQLite → ScoreInputBuilder → ScoreSnapshot
```

## 默认评分代理

| 资产桶 | 默认代理 | 自动指标 |
|---|---|---|
| 黄金 | 上海金 `Au99.99` | `sge_daily` 收盘价；FRED `DFII10` 实际利率、`DTWEXBGS` 美元广义指数；WGC Goldhub 全球黄金 ETF 三月滚动流量（`VALID`，失败时回退国内黄金 ETF 份额/NAV 代理并标 `PARTIAL`） |
| 红利与价值 | 上证 50 `000016.SH` | `index_daily` 行情；官方指数 PE/PB 或 `index_weight + daily_basic` 成分股聚合；财务与分红稳定性可回填 |
| 科技与成长 | 创业板指 `399006.SZ` | 官方/成分股聚合 PE_TTM 与 PS；Tech v1.4 不再使用 Forward PE（PEG_TTM 由 PE_TTM 与实际盈利增长确定性派生） |
| 宽基权益 | 沪深 300 `000300.SH` | 官方指数 PE/PB 或成分股聚合；真实成分股盈利增长优先于价格/PE 派生值 |

这些是评分代理，不是用户真实持仓。可用 `TUSHARE_GOLD_PROXY`、`TUSHARE_VALUE_PROXY`、`TUSHARE_TECH_PROXY` 和 `TUSHARE_BROAD_PROXY` 覆盖代码。

## 运行方式

页面点击“一键自动刷新评分”，或运行：

```bash
pnpm data:refresh
```

首次建库或 `FULL_BACKFILL=true` 时拉取 5 年行情、月频估值快照及可获得的财务历史；日常刷新只拉取增量窗口。`daily_basic` 每个交易日只请求一次全市场数据，再在本地按指数权重聚合。自动值与手工值并存；同一日期上 `is_manual_override=true` 的记录始终优先。

增量模式下，派生盈利增长（`EARNINGS_GROWTH` / `INDEX_EARNINGS_GROWTH`）会跨运行读取数据库中的 `PRICE_CLOSE` 与 `PE_TTM` 历史，按 `available_at` 做点内配对后计算约一年同比，因此即使本次请求只带回最新一天估值，也不会让财务基本面永久停在首次回填日期。若某桶没有任何可用 PE 历史，刷新报告会显式给出告警而不是静默跳过。

`pnpm worker` 为常驻进程，每 6 小时触发一轮刷新；服务端（`app/api/data/refresh`）与页面按钮（同源 server action）共用同一条刷新链路。

同一报告期发生修订时，数据库以 `observed_at + available_at` 存储多个版本。评分和回测只选择 `available_at <= evaluationDate` 的最后一个版本，避免未来数据泄漏；回测取 `PRICE_CLOSE` 时同样按 `available_at` 过滤，并对同一 `as_of` 的多个来源按「手工覆盖 > 主 Provider > VALID > 最新 available_at/fetched_at」确定性选行，同时统计“顺延前值”的评估区间。

## 降级规则

- 单个接口失败不会删除旧观察值。
- 有部分数据时状态为 `DEGRADED`，仍对可计算资产更新评分。
- `index_dailybasic` 是可选快路径；若权限不足，自动切换成分股聚合，不会中断评分链路。
- 数据状态区分 `MISSING`、`PERMISSION_DENIED` 与 `PARTIAL_PROXY`，不会笼统显示为“缺数据”。
- 缺少的指标不会伪造；覆盖率低于 60% 为 LOW，60%–80% 为 MEDIUM，代理和派生指标最高 MEDIUM。
- 指标最新观察（`asOf` 与 `availableAt` 较晚者）距评估日超过 180 天时，该组件可信度降为 LOW（分数不变），由状态机封顶为 `LOW_CONFIDENCE`，避免用陈旧数据输出增配。
- 价格/PE 派生盈利、黄金 ETF 国内代理等以 `PARTIAL` 质量入库；WGC 全球流量为官方月度修订口径，标 `VALID`。
