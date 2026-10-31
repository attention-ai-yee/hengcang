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

实测：顺序发 100 个请求，Tushare 全程只用了 1 条连接。2026-10-31 第一次云端全量回填开了 5 条（限流器先连发一分钟额度再干等，干等时连接被关），之后改成均匀发请求（默认每 0.5 秒一个）。一个 token 一天里最好只做一次全量回填 + 几次自检，留足余量。

## 步骤

```bash
cd hengcang
pnpm install
mkdir -p /tmp/hengcang-verify
export DATABASE_URL=/tmp/hengcang-verify/hengcang.db   # 临时库，不要放进仓库
pnpm db:migrate && pnpm db:seed
FULL_BACKFILL=true pnpm data:refresh    # 约 10 分钟；status 为 READY，或只因没配 FRED 而 DEGRADED
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

## 数据存档：不用每次全量回填

云端数据库是临时的，会话结束就没了。市场数据存档放在**私有仓库 `attention-ai-yee/etf-trend` 的 `hengcang-data` 分支**（只有这一个用途，和 etf-trend 的代码无关）。

- **本仓库（hengcang）是公开的，存档绝不能提交到这里。** `.gitignore` 已忽略 `data/snapshots/` 和 `*.sqlite.gz`；提交前看一眼 `git status`。
- 存档只含市场数据（行情、官方估值、成分股汇总的估值与财报、指数成分权重、数据源状态、评分），没有持仓、组合设置、投资逻辑、新闻、手工录入的数值（`src/server/market-snapshot.ts`）。
- 会话里没有 etf-trend 时，先把它加进会话（需要推送权限）。

分支里已有存档时，用存档代替全量回填：

```bash
DATA=/tmp/hengcang-data
git clone --depth 1 --branch hengcang-data "$(git -C ../etf-trend remote get-url origin)" $DATA
cd hengcang && pnpm install
export DATABASE_URL=/tmp/hengcang-verify/hengcang.db
pnpm db:migrate && pnpm db:seed
pnpm snapshot:import $DATA/market-data.sqlite.gz
pnpm data:refresh        # 增量：平时十几次 Tushare 调用；财报到期时（财报季每天、平时每周）约 400 次、3–4 分钟
pnpm self-check
```

分支里还没有存档（`market-data.sqlite.gz` 不存在）时，按上面「步骤」全量回填一次。

每次跑完都把存档推回去（分支只留一个提交，每次 amend 后强推）：

```bash
pnpm snapshot:export     # → data/snapshots/market-data.sqlite.gz 和 .json
cp data/snapshots/market-data.sqlite.gz data/snapshots/market-data.sqlite.gz.json $DATA/
cd $DATA && git add -A && git commit --amend -m "data: hengcang market data as of <最新行情日期>" && git push -f origin hengcang-data
```

## 汇报给用户

- self-check 里每个 ✗ / ⚠ 的原因和处理办法。
- 各资产今天的数：价格、便宜程度、趋势、配置吸引力、体检（最新 / 上一期、以哪期财报为主）、状态。self-check 的「评分复算」和下面一行已经包含这些。
- `db:seed` 写的是模板持仓，不是用户的真实仓位：「超配」等跟仓位有关的状态只反映模板，要说明。
- 可选：`pnpm build && pnpm start`，用 Playwright 截 `/scores` 页面图发给用户。

## 收尾

- 先把存档推回 `hengcang-data` 分支，再删除 `/tmp/hengcang-verify` 和 `/tmp/hengcang-data`。
- 确认 `git status` 干净：不要提交数据库、`.env.local` 或任何含 Token 的文件。
