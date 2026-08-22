# 自动数据刷新

自动刷新主链路为：

```text
Tushare API → Canonical Observation → SQLite → ScoreInputBuilder → ScoreSnapshot
```

## 默认评分代理

| 资产桶 | 默认代理 | 自动指标 |
|---|---|---|
| 黄金 | 上海金 `Au99.99` | 收盘价、趋势、价格位置、MA200 偏离、3M 动量、美国 10 年实际利率 |
| 红利与价值 | 上证 50 `000016.SH` | 收盘价、PE TTM、PB、由价格/PE 推导的隐含盈利增长 |
| 科技与成长 | 创业板指 `399006.SZ` | 收盘价、PE TTM（作为 Forward PE 的低质量代理）、PB、隐含盈利增长 |
| 宽基权益 | 沪深 300 `000300.SH` | 收盘价、PE TTM、PB、隐含指数盈利增长 |

这些是评分代理，不是用户真实持仓。可用 `TUSHARE_GOLD_PROXY`、`TUSHARE_VALUE_PROXY`、`TUSHARE_TECH_PROXY` 和 `TUSHARE_BROAD_PROXY` 覆盖代码。

## 运行方式

页面点击“一键自动刷新评分”，或运行：

```bash
pnpm data:refresh
```

刷新会拉取近 5 年历史，按 provider 和观察时间幂等更新。自动值与手工值并存；同一日期上 `is_manual_override=true` 的记录始终优先。

## 降级规则

- 单个接口失败不会删除旧观察值。
- 有部分数据时状态为 `DEGRADED`，仍对可计算资产更新评分。
- 账号权限不足会在“数据状态”显示具体接口错误。
- 缺少的指标不会伪造；评分引擎按剩余权重重算并降低 confidence。
- TTM PE 作为科技 Forward PE 代理时以 `PARTIAL` 质量入库。
