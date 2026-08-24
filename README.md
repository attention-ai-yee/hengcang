# 衡仓（Hengcang）

本地优先的个人资产配置、估值监控与风险纪律 Dashboard。系统只提供决策支持，不连接券商、不保存券商密码，也不执行交易。

## 当前状态

当前仓库完成了 MVP 的可运行框架：

- Next.js App Router、TypeScript、Tailwind CSS 与响应式产品导航；
- SQLite + Drizzle ORM，包含 14 张核心业务表和首个 migration；
- 手工资产模板、持仓 CRUD API、资产汇总、目标偏离和未拆分账户警告；
- Dashboard、资产评分、持仓风险、再平衡、决策日志、回测、数据状态和设置页面；
- Manual、Tushare、FRED、Twelve Data Provider Adapter 边界；
- 评分引擎 v1：黄金、红利价值、科技成长、宽基权益四套独立模型；
- 无前视滚动百分位、缺失指标重权、50/30/20 配置吸引力分、硬仓位规则、3 日确认和 7 天冷却；
- `reserved_cash` 预留资金与基于可投资资产的仓位计算；
- 资产汇总、单股/主题 ETF 上限和规范案例 A–E 单元测试；
- Tushare 自动纵切：近 5 年行情、指数估值、实际利率、派生指标、观察值入库与 ScoreSnapshot；
- Manual CSV/JSON 预览、幂等提交和手工覆盖优先级；
- Point-in-time 回测：月末公共评估日网格上对比持有基准、固定比例（月度/季度）再平衡、评分映射（±仓位上限）与状态门控策略，信号 T+1 执行并计入交易成本，输出总收益/年化/最大回撤/最差年度/最长回撤期/波动率/夏普/换手。

Decision Log 结果回填及其他自动 Provider 的全部指标映射仍属于后续业务纵切。

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
pnpm test          # 领域单元测试
pnpm typecheck     # TypeScript 检查
pnpm lint          # ESLint
pnpm build         # 生产构建
pnpm db:generate   # 根据 schema 生成 migration
pnpm db:migrate    # 应用 migration
pnpm db:seed       # 写入本地示例资产模板
pnpm data:refresh  # 自动拉取 Tushare 数据并重算评分
pnpm backtest      # 只读回测报告（--persist 落库，--cost N 覆盖成本假设）
pnpm worker        # 启动本地定时刷新进程
```

## 环境变量

复制 `.env.example` 为 `.env.local`。除 `DATABASE_URL` 外，其余 Provider Key 均可选；没有 Key 时 Manual Provider 仍然可用。

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | SQLite 文件路径，默认 `./data/hengcang.db` |
| `REFRESH_TOKEN` | 后续云端 refresh endpoint 的服务端令牌 |
| `TUSHARE_TOKEN` | A 股、ETF、基金等 Tushare 数据 |
| `FRED_API_KEY` | FRED 宏观序列 |
| `TWELVE_DATA_API_KEY` | 黄金代理与全球行情 |
| `TUSHARE_*_PROXY` | 可选：覆盖四类资产的默认评分代理代码 |

API Key 只能放在服务端环境变量中。Settings 页面仅显示是否已配置，不接收或持久化密钥。

## 架构

```text
app/                 页面与 Route Handlers
src/domain/          无框架依赖的资产、风险、评分逻辑
src/db/              Drizzle schema、连接与查询
src/providers/       外部数据 Adapter
src/server/          服务层与数据库编排
src/components/      产品 UI 与图表
scripts/             种子、手工刷新、本地 worker
tests/               单元、集成与 E2E 测试
drizzle/             版本化 SQL migration
```

领域层不依赖 Next.js 或数据库，便于测试。数据库中的金额使用“最小货币单位字符串”，进入领域层后转换为 `bigint`，避免浮点金额误差。市场观察值同时保存 `observed_at`、`available_at`、`as_of` 和 `fetched_at`，为后续无前视偏差回测保留基础。

评分引擎默认配置位于 `src/domain/scoring/default-config.json`。`OpportunityScore` 在界面统一显示为“配置吸引力分”，方向为“越高越值得考虑配置”：

```text
OpportunityScore = 50% × Cheapness + 30% × Fundamental + 20% × Trend
```

评分计算只读取评估日已经发布的数据；基本面低于 35、仓位超限和低可信度会在配置吸引力分之后覆盖普通状态。

## 自动评分刷新

配置 `TUSHARE_TOKEN` 后，在“资产评分”或“数据状态”点击“一键自动刷新评分”，也可以运行 `pnpm data:refresh`。系统会拉取近 5 年数据，幂等写入观察值，生成价格派生指标并更新四类 `ScoreSnapshot`。默认代理和指标映射见 [自动数据刷新](docs/automatic-data-refresh.md)。

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
2. 风险聚合、迟滞、冷却和信号去重；
3. Decision Log 写入与结果回填；
4. 回测增强：季度/月度频率参数化 UI、净值曲线图、参数敏感性扫描；
5. E2E 与 Docker 本地部署。
