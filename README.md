# 衡仓（Hengcang）

本地优先的个人资产配置、估值监控与风险纪律 Dashboard。系统只提供决策支持，不连接券商、不保存券商密码，也不执行交易。

## 当前状态

当前仓库完成了 MVP 的可运行框架：

- Next.js App Router、TypeScript、Tailwind CSS 与响应式产品导航；
- SQLite + Drizzle ORM，包含 19 张核心业务表和 8 个版本化 migration；
- 手工资产模板、持仓 CRUD API、资产汇总、目标偏离和未拆分账户警告；
- Dashboard、资产评分、持仓与风险、决策日志、回测、数据状态和设置页面（再平衡已并入持仓页）；
- Manual、Tushare、FRED、Twelve Data、WGC Goldhub Provider Adapter 边界；
- 七个资产桶：现金与债券、黄金、红利与价值、科技与成长、宽基权益、海外权益、其他；v2 默认配置为 60% 权益、其中海外 25%（海外权益只按战略目标与区间管理，不打分）；
- 评分引擎：黄金、红利价值、科技成长 v1.4、宽基权益四套独立模型，趋势模型 v1.3；基本面 v2 改为「体检 + 熔断」（恶化即暂停新增、重新评估），黄金宏观支持度只展示；
- 无前视滚动百分位与数据新鲜度闸门、缺失指标重权、70/30 配置吸引力分（便宜程度/趋势）、硬仓位规则（单股 8% / 主题 ETF 15% / 单一主题 20%）接入评分状态、3 日确认和 7 天冷却；
- `reserved_cash` 预留资金与基于可投资资产的仓位计算；
- 持仓级投资逻辑、失效条件与事件日志：单一个股和主题 ETF 必写；消息对应到失效条件即暂停新增，写完复核才解除；
- AI 新闻监控（DeepSeek 搜索 + 模型）：每天自动搜索持仓新闻、对照失效条件判断，证据确凿的自动暂停新增，其余一键确认或忽略，误判一键撤销；
- 资产汇总、单股/主题 ETF 上限和规范案例 A–E 单元测试；
- Tushare 自动纵切：近 5 年行情、指数估值、实际利率、派生指标、观察值入库与 ScoreSnapshot；
- Manual CSV/JSON 预览、幂等提交和手工覆盖优先级；
- Point-in-time 回测：月末公共评估日网格上对比持有基准、固定比例（月度/季度）再平衡、评分映射（±仓位上限）与状态门控策略；信号在下一个评估日（月末）收盘成交，价格按 `available_at` 做点内选取，落库时记录评估网格与评分配置快照；输出总收益/年化/最大回撤/最差年度/最长回撤期/波动率/夏普/换手/调仓桶次。

决策日志写入、信号生成/去重与 7 天冷却已经接通（`POST /api/decisions`）；Decision Log 的 30/90/180 天结果回填、其他自动 Provider 的完整指标映射、设置页可编辑与 E2E 仍属于后续业务纵切。

## 本地启动

需要 Node.js 20.9+ 与 pnpm。

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 <http://localhost:3000>。`db:seed` 是显式操作：它会写入规格中的 ¥590,000 手工资产模板，并保留黄金、其他科技资产的约数标记，以及股票账户待拆分警告。

## 常用命令

```bash
pnpm test          # 单元与集成测试
pnpm typecheck     # TypeScript 检查
pnpm lint          # ESLint
pnpm build         # 生产构建
pnpm db:generate   # 根据 schema 生成 migration
pnpm db:migrate    # 应用 migration
pnpm db:seed       # 写入本地示例资产模板
pnpm data:refresh  # 自动拉取 Tushare 数据并重算评分
pnpm backtest      # 只读回测报告（--persist 落库，--cost N 覆盖成本假设）
pnpm worker        # 常驻定时进程：每 6 小时刷新数据，并每天扫描一次新闻（Ctrl+C 退出）
pnpm news:scan     # AI 新闻监控：扫描到期的投资逻辑（--force 立即扫描全部）
```

## 环境变量

复制 `.env.example` 为 `.env.local`。除 `DATABASE_URL` 外，其余 Provider Key 均可选；没有 Key 时 Manual Provider 仍然可用。

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | SQLite 文件路径，默认 `./data/hengcang.db` |
| `REFRESH_TOKEN` | 可选：配置后 `/api/data/refresh` 与 `/api/backtest/run` 要求 Bearer 令牌；页面按钮走同源 server action，不受影响 |
| `TUSHARE_TOKEN` | A 股、ETF、基金等 Tushare 数据 |
| `FRED_API_KEY` | FRED 宏观序列 |
| `TWELVE_DATA_API_KEY` | 黄金代理与全球行情 |
| `DEEPSEEK_API_KEY` | AI 新闻监控：DeepSeek 搜索、抓取与模型共用一个 Key |
| `DEEPSEEK_MODEL` | 可选：判断用的模型，默认 `deepseek-flash` |
| `TUSHARE_*_PROXY` | 可选：覆盖四类资产的默认评分代理代码 |

API Key 只能放在服务端环境变量中。Settings 页面仅显示是否已配置，不接收或持久化密钥。

## 架构

```text
app/                 页面与 Route Handlers
src/domain/          无框架依赖的资产、风险、评分逻辑
src/db/              Drizzle schema、连接与查询
src/providers/       外部数据 Adapter
src/server/          服务层与数据库编排
src/server/actions/  页面按钮使用的 server action（刷新 / 回测）
src/components/      产品 UI 与图表
scripts/             种子、手工刷新、本地 worker
tests/               单元与集成测试（E2E 待补）
drizzle/             版本化 SQL migration
```

领域层不依赖 Next.js 或数据库，便于测试。数据库中的金额使用“最小货币单位字符串”，进入领域层后转换为 `bigint`，避免浮点金额误差。市场观察值同时保存 `observed_at`、`available_at`、`as_of` 和 `fetched_at`；评分与回测在评估日只使用 `available_at` 不晚于评估日的观测，关键指标超过 180 天未更新时将可信度降为 LOW（只降级、不改分数）。

评分引擎默认配置位于 `src/domain/scoring/default-config.json`。`OpportunityScore` 在界面统一显示为“配置吸引力分”，方向为“越高越值得考虑配置”：

```text
OpportunityScore = 70% × Cheapness + 30% × Trend
```

基本面不再进入分数，改为体检：盈利同比最近两期（相隔约一个季度）都为负（科技再看营收，红利再看分红稳定性）即判定恶化，即时输出「重新评估投资逻辑」并暂停新增；体检数据不足时最多输出小幅增配。规则与理由见 [v2 设计说明](docs/hengcang_v2_allocation_fundamentals_thesis.md)。

评分计算只读取评估日已经发布的数据；基本面体检不通过、单股/主题硬上限违规、桶仓位超限和低可信度（含数据超过 180 天未更新）会在配置吸引力分之后覆盖普通状态。风险严重度：硬上限违规为 CRITICAL，重新评估/超配为 WARNING，低可信度为 WATCH。趋势 v1.3 与科技 v1.4 的模型细节见 [模型修订](docs/hengcang_trend_v1_3_tech_v1_4.md)。

## 自动评分刷新

配置 `TUSHARE_TOKEN` 后，在“资产评分”或“数据状态”点击“一键自动刷新评分”，也可以运行 `pnpm data:refresh`。首次运行（或 `FULL_BACKFILL=true`）回填近 5 年数据，日常增量拉取近 1 年；财报（`fina_indicator`）与分红每周增量刷新一次（近 15 个月窗口）。价格/PE 派生的盈利增长单独存为 `*_DERIVED` 指标，只作参考、不进体检；WGC 不可用时回退国内黄金 ETF 代理。观察值幂等写入，生成价格派生指标并更新四类 `ScoreSnapshot`。默认代理和指标映射见 [自动数据刷新](docs/automatic-data-refresh.md)。

## 决策日志与信号

“决策日志”页面记录每次人工动作（加仓/减仓/保持/暂停新增），写入时快照当时的评分状态与组合分布（`POST /api/decisions`）。记录 ADD / REDUCE 后，同方向建议在 7 天内被冷却抑制（评分照常更新，只是 `allowAdd=false`）。

评分刷新只在推荐状态发生变化或出现硬上限违规时写入 `signals`（fingerprint 去重，仅最新评估日生成），因此仪表盘“最新信号”不会在状态不变时重复刷屏。

## 投资逻辑与失效条件

消息不会自动变成分数。在“持仓与风险”页点进某个持仓（`/holdings/[id]`），写下投资逻辑和 3–5 条可验证的失效条件；之后有消息就记录一条事件（日期、摘要、来源链接），对应到某条失效条件即触发：该持仓暂停新增，写一条 WARNING 信号，仪表盘常驻提醒，直到写完复核解除。已触发的条件不能删改；每 90 天提示一次季度复核。暂停是持仓级的，不改变所在资产桶的评分。详见 [v2 设计说明 §4](docs/hengcang_v2_allocation_fundamentals_thesis.md)。

配置 `DEEPSEEK_API_KEY` 后，消息不用你自己找：AI 每天自动搜索每只持仓最近 30 天的新闻，先按摘要初筛，再带正文复核。只有复核高置信、证据能在原文里逐字找到、30 天内、来源可靠的才自动触发；其余标为「可能触发」，一键确认或忽略。AI 触发的可以一键撤销（不算复核）。没写逻辑的持仓可以「让 AI 起草」。发给 DeepSeek 的只有持仓名称、代码、逻辑和条件，不含金额。详见 [v2 设计说明 §7](docs/hengcang_v2_allocation_fundamentals_thesis.md)。

## Manual 指标导入（高级兜底）

只有 Provider 无权提供个别指标时才需要打开“数据状态”中的高级兜底。选择或粘贴 CSV/JSON，先执行“校验并预览”，再执行“提交并计算评分”。完整字段说明见 [Manual 指标导入](docs/manual-observation-import.md)。

## Provider 扩展

新增 Provider 时实现 `src/providers/types.ts` 中的 `MarketDataProvider`：

1. 声明实际支持的 capability；
2. 返回带 provider、fetchedAt、quality 的 `ProviderResult`；
3. 权限、限流和上游错误必须结构化返回，并允许 Manual fallback；
4. 不得覆盖 `isManualOverride` 或手工锁定持仓值；
5. 不得在业务代码中加入网页抓取逻辑。

## 数据与隐私

- 本地数据库位于 `data/`，已被 git 忽略；迁移文件会进入版本控制。
- 日志不得输出 API Key 或账户凭据。
- 当前没有用户登录，禁止把这一版本直接暴露到公网。
- 删除或备份时先停止开发服务器与 worker，再复制或删除 SQLite 数据库文件。

## 下一步实现顺序

1. FRED / Twelve Data 指标映射与多源 fallback；
2. Decision Log 的 30/90/180 天结果回填；
3. 设置页可编辑战略仓位 / 风险上限 / 评分权重；
4. 回测增强：季度/月度频率参数化 UI、净值曲线图、参数敏感性扫描；
5. E2E 与 Docker 本地部署。
