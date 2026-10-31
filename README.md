# 衡仓（Hengcang）

本地优先的个人资产配置、估值监控与风险纪律 Dashboard。系统只提供决策支持，不连接券商、不保存券商密码，也不执行交易。

## 当前状态（2026-10-31）

v2 已完成并合入 `main`：默认配置改为 60% 权益、其中海外 25%；基本面从打分改成「体检 + 熔断」；单一个股和主题 ETF 有持仓级投资逻辑与失效条件；AI 每天自动搜索新闻、对照失效条件判断。代码检查全部通过，AI 新闻监控已用真实 DeepSeek 接口跑通；依赖 Tushare 的部分要在有 Token 的电脑上跑一次全量回填（见「从旧版本升级」）。

| 部分 | 状态 |
|---|---|
| 默认配置（海外权益桶、权益 60% / 海外 25%） | 完成。迁移只改写仍是旧默认值的组合 |
| 基本面体检（恶化即暂停新增） | 完成。按报告期比较最近两期，上一期取那一期最完整的点；旧数据要全量回填一次才有报告期标记 |
| 财报数据（每周增量刷新，重算最近 30 天） | 完成。2026-10-30 用真实 Tushare 数据全量回填验证过（366 只成分股、约 7300 份财报），据此又修了三处（见 [CODE_REVIEW.md](CODE_REVIEW.md)） |
| 投资逻辑、失效条件、事件日志 | 完成 |
| AI 新闻监控（DeepSeek 搜索 + 模型） | 完成。2026-10-28 用真实接口跑通「AI 起草 → 保存 → 检查新闻」 |
| 评分计算 | 2026-10-31 端到端核算后修正（模型版本 7）：分位只看近 5 年、估值按月取样、一条序列只用一个来源、中位秩，见 [v2 设计说明 §8](docs/hengcang_v2_allocation_fundamentals_thesis.md) |
| 测试 | `tsc`、`eslint`、`next build` 通过；47 个测试文件、325 个测试全部通过（含全链路核算：合成数据跑完整刷新，测试内独立重算评分逐项对比） |
| 依赖安全 | 2026-10-31 升级 Next.js 16.4.3、zod 4.6.7 等，生产依赖没有已知漏洞；服务器默认只监听本机 |
| 代码审查 | 2026-10-28 两路复查、10-30 真实数据复查、10-31 计算复查发现的问题已修，剩余的低危项见 [CODE_REVIEW.md](CODE_REVIEW.md) |

已有功能：

- Next.js App Router、TypeScript、Tailwind CSS 与响应式产品导航；SQLite + Drizzle ORM，19 张核心业务表、8 个版本化 migration；
- 手工资产模板、持仓 CRUD API、资产汇总、目标偏离和未拆分账户警告；`reserved_cash` 预留资金与基于可投资资产的仓位计算；
- Dashboard、资产评分、持仓与风险（含再平衡参考）、持仓详情（投资逻辑与新闻）、决策日志、回测、数据状态和设置页面；
- 七个资产桶：现金与债券、黄金、红利与价值、科技与成长、宽基权益、海外权益、其他。海外权益、现金与债券、其他不打分，只按战略目标与区间管理；
- 评分引擎：黄金、红利价值、科技成长 v1.4、宽基权益四套模型，趋势模型 v1.3；配置吸引力分 = 70% 便宜程度 + 30% 趋势；基本面体检不通过即时「重新评估投资逻辑」；黄金宏观支持度只展示；
- 无前视滚动百分位与 180 天数据新鲜度闸门、缺失指标重权、硬仓位规则（单股 8% / 主题 ETF 15% / 单一主题 20%）接入评分状态、3 日确认和 7 天冷却；
- 持仓级投资逻辑与失效条件：消息对应到失效条件即暂停新增，写完复核才解除；每 90 天提示季度复核；
- AI 新闻监控：每天自动搜索持仓最近 30 天的新闻，证据确凿的自动暂停新增，其余一键确认或忽略，误判一键撤销；没写逻辑的持仓可以让 AI 起草；
- Tushare 自动数据：近 5 年行情、指数估值、成分股财报汇总、分红、实际利率；Manual CSV/JSON 导入（预览、幂等提交、手工值优先）；
- Point-in-time 回测：月末评估日网格上对比持有、固定比例再平衡、评分映射与状态门控策略，信号在下一个评估日收盘成交，输出收益、回撤、波动、夏普、换手等；
- 决策日志、信号生成与去重、7 天冷却（`POST /api/decisions`）。

## 本地启动

需要 Node.js 20.9+ 与 pnpm。

```bash
pnpm install
cp .env.example .env.local   # 填 TUSHARE_TOKEN；可选 DEEPSEEK_API_KEY
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://localhost:3000>。`db:seed` 是显式操作：它会写入规格中的 ¥590,000 手工资产模板，并保留黄金、其他科技资产的约数标记，以及股票账户待拆分警告。想让数据和新闻自动更新，另开一个终端常驻 `pnpm worker`。

### 从旧版本升级

1. 停掉 `pnpm dev` 和 `pnpm worker`，先备份数据库：`cp data/hengcang.db data/hengcang.backup.db`。
2. `git pull && pnpm install && pnpm db:migrate`。
3. 跑一次全量回填：`FULL_BACKFILL=true pnpm data:refresh`，完成后跑 `pnpm self-check` 核对。它会按修正后的规则重算历史财报汇总、补上报告期标记和占比，体检才能按报告期比较；比平时慢，也会多用一些 Tushare 额度。
4. 可选：在 `.env.local` 填 `DEEPSEEK_API_KEY` 开启 AI 新闻监控，重启 `pnpm dev`，并常驻 `pnpm worker`。
5. 在「持仓与风险」里给单一个股和主题 ETF 写投资逻辑和失效条件（可以先点「让 AI 起草」，改好再保存）。股票账户如果还是一条汇总记录，先拆成具体持仓。

要回退：停服务，`git checkout` 回升级前的提交（v2 之前是 `8ef4160`），把备份拷回 `data/hengcang.db`。

## 常用命令

```bash
pnpm test          # 单元与集成测试
pnpm typecheck     # TypeScript 检查
pnpm lint          # ESLint
pnpm build         # 生产构建
pnpm db:generate   # 根据 schema 生成 migration
pnpm db:migrate    # 应用 migration
pnpm db:seed       # 写入本地示例资产模板
pnpm data:refresh  # 自动拉取 Tushare 数据并重算评分（FULL_BACKFILL=true 全量回填）
pnpm backtest      # 只读回测报告（--persist 落库，--cost N 覆盖成本假设）
pnpm worker        # 常驻定时进程：每 30 分钟检查一次，数据距上次成功刷新满 6 小时就刷新，新闻每天扫一次（Ctrl+C 退出）
pnpm news:scan     # AI 新闻监控：扫描到期的投资逻辑（--force 立即扫描全部）
pnpm self-check    # 用真实接口核对数据与计算（只读）：行情与 Tushare 一致、估值口径、财报新鲜度、评分复算、DeepSeek 搜索/读网页/模型
```

## 环境变量

复制 `.env.example` 为 `.env.local`。除 `DATABASE_URL` 外，其余 Provider Key 均可选；没有 Key 时 Manual Provider 仍然可用。

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | SQLite 文件路径，默认 `./data/hengcang.db` |
| `REFRESH_TOKEN` | 可选：配置后 `/api/data/refresh` 与 `/api/backtest/run` 要求 Bearer 令牌；页面按钮走同源 server action，不受影响 |
| `TUSHARE_TOKEN` | A 股、ETF、基金等 Tushare 数据 |
| `TUSHARE_MAX_RPM` / `TUSHARE_CONCURRENCY` | 可选：Tushare 每分钟请求数（默认 120）与并发（默认 3）；留空按默认值 |
| `FRED_API_KEY` | FRED 宏观序列 |
| `TWELVE_DATA_API_KEY` | 黄金代理与全球行情 |
| `DEEPSEEK_API_KEY` | AI 新闻监控：DeepSeek 搜索、抓取与模型共用一个 Key |
| `DEEPSEEK_MODEL` | 可选：判断用的模型，默认 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | 可选：一般不用填，只在走自建网关或本地联调时覆盖官方地址 |
| `TUSHARE_*_PROXY` | 可选：覆盖四类资产的默认评分代理代码 |

API Key 只能放在服务端环境变量中，不要贴到聊天里或提交进仓库。Settings 页面仅显示是否已配置，不接收或持久化密钥。

## 架构

```text
app/                 页面与 Route Handlers
src/domain/          无框架依赖的资产、风险、评分、体检、投资逻辑与新闻判断规则
src/db/              Drizzle schema、连接与查询
src/providers/       外部数据 Adapter（Tushare、FRED、WGC、DeepSeek 等）
src/server/          服务层与数据库编排
src/server/actions/  页面按钮使用的 server action（刷新、回测、新闻监控）
src/components/      产品 UI 与图表
scripts/             种子、手工刷新、新闻扫描、本地 worker
tests/               单元与集成测试（E2E 待补）
drizzle/             版本化 SQL migration
```

领域层不依赖 Next.js 或数据库，便于测试。数据库中的金额使用“最小货币单位字符串”，进入领域层后转换为 `bigint`，避免浮点金额误差。市场观察值同时保存 `observed_at`、`available_at`、`as_of` 和 `fetched_at`；评分与回测在评估日只使用 `available_at` 不晚于评估日的观测，关键指标超过 180 天未更新时将可信度降为 LOW（只降级、不改分数）。

评分引擎默认配置位于 `src/domain/scoring/default-config.json`。`OpportunityScore` 在界面统一显示为“配置吸引力分”，方向为“越高越值得考虑配置”：

```text
OpportunityScore = 70% × Cheapness + 30% × Trend
```

基本面不进入分数，改为体检：盈利同比最近两个报告期都为负（科技再看营收，红利再看分红稳定性 < 60）即判定恶化——指数层面的增速取成分股按权重的中位数，即一半以上的权重在下滑，即时输出「重新评估投资逻辑」并暂停新增；体检数据不足时最多输出小幅增配。「上一期」按报告期找（旧数据没有报告期标记时按约一个季度的间隔）；基金拿不到成分财报时可以手工给基本面判断，只在 180 天内有效。规则与理由见 [v2 设计说明 §3](docs/hengcang_v2_allocation_fundamentals_thesis.md)。

评分计算只读取评估日已经发布的数据；基本面体检不通过、单股/主题硬上限违规、桶仓位超限和低可信度（含数据超过 180 天未更新）会在配置吸引力分之后覆盖普通状态。风险严重度：硬上限违规为 CRITICAL，重新评估/超配为 WARNING，低可信度为 WATCH。趋势 v1.3 与科技 v1.4 的模型细节见 [模型修订](docs/hengcang_trend_v1_3_tech_v1_4.md)。

## 自动评分刷新

配置 `TUSHARE_TOKEN` 后，在“资产评分”或“数据状态”点击“一键自动刷新评分”，也可以运行 `pnpm data:refresh`。首次运行（或 `FULL_BACKFILL=true`）回填近 5 年数据，日常增量拉取近 1 年。

- 财报（`fina_indicator`）与分红在财报季（3/15–5/5、7/15–9/5、10/1–11/5）每天增量刷新一次、其余时间每周一次（近 15 个月窗口），并重算最近 30 天的桶级汇总，晚几天才进 Tushare 的财报也能并进来；每个汇总行记下按权重占主导的报告期。
- 价格/PE 推算的盈利增长单独存为 `*_DERIVED` 指标，只作参考、不进体检；WGC 不可用时回退国内黄金 ETF 代理。
- 观察值幂等写入；手工导入的值不会被自动刷新删除或覆盖。

默认代理和指标映射见 [自动数据刷新](docs/automatic-data-refresh.md)。

## 决策日志与信号

“决策日志”页面记录每次人工动作（加仓/减仓/保持/暂停新增），写入时快照当时的评分状态与组合分布（`POST /api/decisions`）。记录 ADD / REDUCE 后，同方向建议在 7 天内被冷却抑制（评分照常更新，只是 `allowAdd=false`）。

评分刷新只在推荐状态发生变化或出现硬上限违规时写入 `signals`（fingerprint 去重，仅最新评估日生成），因此仪表盘“最新信号”不会在状态不变时重复刷屏。

## 投资逻辑与 AI 新闻监控

消息不会自动变成分数。在“持仓与风险”页点进某个持仓（`/holdings/[id]`），写下投资逻辑和 3–5 条可验证的失效条件（可以先「让 AI 起草」）。消息对应到某条失效条件即触发：该持仓暂停新增，写一条 WARNING 信号，仪表盘常驻提醒，直到写完复核解除。已触发的条件不能删改；每 90 天提示一次季度复核。暂停是持仓级的，不改变所在资产桶的评分。详见 [v2 设计说明 §4](docs/hengcang_v2_allocation_fundamentals_thesis.md)。

配置 `DEEPSEEK_API_KEY` 后，消息不用你自己找：

- 每份投资逻辑每天扫描一次：模型根据逻辑和条件生成搜索词，搜索最近 30 天的新闻，同一标题的转载只看一次，先按摘要初筛，再带正文复核。
- 下面几条同时满足才自动暂停新增：复核高置信；证据能在原文里逐字找到；文章有发布日期且在 30 天内；来源可靠；事件晚于写下这条条件、也晚于你上次对它的复核或撤销。
- 其余标为「可能触发」，一键确认或忽略，每条条件最多留一条待确认；AI 触发的可以一键撤销（不算复核）。
- 发给 DeepSeek 的只有持仓名称、代码、逻辑和条件，不含金额和仓位。
- 费用：DeepSeek 搜索、抓取各按每 1000 次成功请求 5 元（2026-11-01 起），每只持仓每月不到 1 元，模型调用按 token 另计。

详见 [v2 设计说明 §7](docs/hengcang_v2_allocation_fundamentals_thesis.md)（含 2026-10-28 用真实接口试跑的记录）。

## Manual 指标导入（高级兜底）

只有 Provider 无权提供个别指标时才需要打开“数据状态”中的高级兜底。选择或粘贴 CSV/JSON，先执行“校验并预览”，再执行“提交并计算评分”。价格和估值倍数必须大于 0。完整字段说明见 [Manual 指标导入](docs/manual-observation-import.md)。

## Provider 扩展

新增 Provider 时实现 `src/providers/types.ts` 中的 `MarketDataProvider`：

1. 声明实际支持的 capability；
2. 返回带 provider、fetchedAt、quality 的 `ProviderResult`；
3. 权限、限流和上游错误必须结构化返回，并允许 Manual fallback；
4. 不得覆盖 `isManualOverride` 或手工锁定持仓值；
5. 不得在业务代码中加入网页抓取逻辑（新闻走 DeepSeek 的搜索 / 抓取 API）。

## 数据与隐私

- 本地数据库位于 `data/`，已被 git 忽略；迁移文件会进入版本控制。
- 日志不得输出 API Key 或账户凭据。
- 当前没有用户登录，禁止把这一版本直接暴露到公网。
- `pnpm dev` 和 `pnpm start` 默认只监听本机（127.0.0.1），同一局域网的其他设备打不开。要在手机上看，用 `pnpm exec next start -H 0.0.0.0`：没有登录，同一网络里的人都能看到和修改你的数据，只在信任的网络里这样做。
- 删除或备份时先停止开发服务器与 worker，再复制或删除 SQLite 数据库文件。

## 已知问题与后续

- **要在有真实数据的环境里验证后再做**：红利价值的评分代理从上证 50 换成中证红利；港股互联网的估值数据；历史成分股权重回填（现在用当前成分，有幸存者偏差）。
- **还没做的功能**：设置页编辑战略仓位和风险上限（现在只读，只能改预留资金）；决策日志的 30/90/180 天结果回填；FRED / Twelve Data 的多源备用；回测页的参数化与净值曲线；E2E 测试与 Docker 部署。
- **已知的低危问题**：手工评分和自动评分写同一个快照键、互相覆盖（手工评分只在当天没有自动数据时用）；配置快照每次刷新重复写入等。完整清单见 [CODE_REVIEW.md](CODE_REVIEW.md) 最新一节的「仍未处理」。
- **Tushare 一个 Token 最多同时用 10 个 IP**：在出网 IP 会变的环境（云端、部分代理）里刷新，次数多了会报「您的IP数量超限」、刷新失败。只在固定 IP 的机器上跑；被限后等一段时间，或在 Tushare 个人中心重置 Token。
- **AI 新闻监控的局限**：搜索引擎没收录的消息会漏，可以手工补记；模型会判断错，所以自动触发只暂停新增、可一键撤销，不会给出卖出建议。

## 文档

- [v2 设计说明](docs/hengcang_v2_allocation_fundamentals_thesis.md)：默认配置、财报数据、基本面体检、投资逻辑、AI 新闻监控、升级步骤
- [自动数据刷新](docs/automatic-data-refresh.md)、[Manual 指标导入](docs/manual-observation-import.md)
- [趋势 v1.3 与科技 v1.4](docs/hengcang_trend_v1_3_tech_v1_4.md)、[黄金模型 v1.2](docs/hengcang_gold_model_revision_v1_2.md)（宏观闸门已在 v2 删除）
- [代码审查记录](CODE_REVIEW.md)
