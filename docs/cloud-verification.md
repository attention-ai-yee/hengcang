# 在云端会话里用真实数据验证

适用于用户本机没有开发环境、在 Claude 云端会话里运行衡仓的情况（2026-10-31 起）。云端容器是临时的：数据库会话结束就没了，每次验证都从头回填。

## 前提

- 云端环境设置里配好了 `TUSHARE_TOKEN` 和 `DEEPSEEK_API_KEY`（会话标题栏的环境菜单 → Edit → Network secrets 或环境变量）。改完要新开一个会话才读得到。
- 不要把 Token / Key 打印出来、写进文件或提交。不要让用户把它们贴进聊天。

## 关键：Tushare 只能用一条连接

云端的出口 IP 按连接分配：同一条长连接上的请求出口 IP 不变，新开一条连接就换一个 IP。Tushare 一个 token 最多同时用 10 个 IP，超了报「您的IP数量超限」，整个 token 被锁一段时间（2026-10-30 发生过）。

- 衡仓默认一次只发一个 Tushare 请求（`TUSHARE_CONCURRENCY` 默认 1），全程复用一条连接。**不要调大。**
- etf-trend 的 Tushare 客户端同样只用一个长连接（2026-10-31 起）。
- 不要用 `tushare` Python 包的 `pro_api`、curl 循环或别的脚本直接调 Tushare：它们每次请求都新开连接。
- 一旦出现「IP数量超限」，衡仓和 etf-trend 都会立刻停止调用。这时停下来告诉用户，等限制解除或在 Tushare 个人中心重置 token。

实测：顺序发 100 个请求，Tushare 全程只用了 1 条连接。

## 步骤

```bash
cd hengcang
pnpm install
mkdir -p /tmp/hengcang-verify
export DATABASE_URL=/tmp/hengcang-verify/hengcang.db   # 临时库，不要放进仓库
pnpm db:migrate && pnpm db:seed
FULL_BACKFILL=true pnpm data:refresh    # 15–30 分钟；status 为 READY，或只因没配 FRED 而 DEGRADED
pnpm self-check                          # 逐项核对，输出就是给用户的报告
```

`pnpm self-check` 应该看到：

| 项目 | 期望 |
|---|---|
| 各资产行情 | ✓ 与 Tushare 现拉的收盘价完全一致 |
| 估值口径 | ✓ 评分用官方指数估值，历史约 5 年 |
| 财报汇总 | ✓ 最新一期、主导报告期占比、覆盖率 |
| 评分复算 | ✓ 与库里一致（第 7 版算法）；下一行是状态和体检明细 |
| DeepSeek | ✓ 新闻搜索、读网页、模型都正常（个别网站读不到正文是正常的） |

## 汇报给用户

- self-check 里每个 ✗ / ⚠ 的原因和处理办法。
- 各资产今天的数：价格、便宜程度、趋势、配置吸引力、体检（最新 / 上一期、以哪期财报为主）、状态。self-check 的「评分复算」和下面一行已经包含这些。
- `db:seed` 写的是模板持仓，不是用户的真实仓位：「超配」等跟仓位有关的状态只反映模板，要说明。
- 可选：`pnpm build && pnpm start`，用 Playwright 截 `/scores` 页面图发给用户。

## 收尾

- 删除 `/tmp/hengcang-verify`。
- 确认 `git status` 干净：不要提交数据库、`.env.local` 或任何含 Token 的文件。
