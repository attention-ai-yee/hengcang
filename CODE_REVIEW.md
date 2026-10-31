# 衡仓（Hengcang）代码审查报告

- **日期**:2026-08-23
- **范围**:全仓库(app/、src/domain/、src/server/、src/metrics/、src/providers/、src/db/、scripts/、tests/、配置与文档)
- **方法**:人工逐文件通读全部源码 + 4 个并行深查(domain / server+metrics / providers+scripts / API+UI);domain 与 API 层关键结论经过对真实代码执行复现验证
- **基线**:`tsc --noEmit` ✅ | `eslint .` ✅ | `vitest run` 13 个文件 40 个测试全部通过 ✅

> 总体评价:架构分层清晰(domain 不依赖框架、provider 结构化返回、金额用最小单位字符串 + bigint)、无前视百分位与修订可见性设计认真。但**测试覆盖集中在 domain 纯函数层,而问题最密集的恰是服务编排层、API 边界与评分引擎的边界条件**——下列问题大多没有测试保护。

---

## 2026-10-31 评分计算复查（最新）

> 用确定性合成数据跑完整的「拉数 → 入库 → 汇总 → 评分」，测试内按规格独立重算便宜程度、趋势、配置吸引力分逐项对比；另用 ETF 真实价格模拟不同历史取样对分位的影响。

**当前基线**：`tsc --noEmit` ✅ | `eslint .` ✅ | `vitest run` 47 个文件 / 325 个测试全部通过 ✅（2026-10-31 实测）。

### 本轮已修复

| 问题 | 修复 |
|---|---|
| 历史分位用全部历史，没有规格 §3.1 的 5 年窗口 | 只看评估日前 5 年 |
| 估值序列回填是月末快照、之后每天一点，近期点占多数，「5 年分位」逐渐变成「近一年分位」（模拟：68 分位 → 15 分位） | 估值、财报、宏观类按月取样；行情派生特征逐日 |
| PE / PB 逐日挑来源，官方口径（当月）拼成分股汇总口径（历史） | 一条序列只用一个来源；全量回填拉 5 年官方估值 |
| 全量回填只拉 5 年行情，动量、MA200 在窗口里只有 4.2–4.5 年的值 | 行情多拉一年 |
| PEG 只取两边同一天都有的点 | 按日期对齐（as-of） |
| L4：分位按「≤ 当前」计数，两个方向不对称 | 中位秩 |
| 5 年没分过红的成分股被剔除，指数分红稳定性偏高 | 有记录无分红按规格得 10 分 |
| 回测「夏普」没扣无风险利率 | 改称「收益/波动比」并注明 |
| Tushare 接口层限流（HTTP 200 + 「每分钟最多访问该接口」）不重试，那只成分股的数据这一轮静默缺掉 | 等过这一分钟再拉同一页，最多三轮；IP 超限等错误照旧如实返回 |
| 财报每周才刷新一次，财报季里新财报最多晚一周进体检 | 财报季每天一次 |
| 没有办法在本机用真实接口核对数据 | 新增 `pnpm self-check`（只读） |

核对过没有问题的：仓位与集中度（统一按扣除预留资金后的可投资资产）、再平衡差额、配置吸引力分合成、状态阈值与确认、基本面体检、PE/PB/PS 调和加权、股息率加权、增速加权中位数、回测收益与回撤。

---

## 2026-10-31 依赖安全与监听地址

**当前基线**：`tsc --noEmit` ✅ | `eslint .` ✅ | `next build` ✅ | `vitest run` 44 个文件 / 301 个测试全部通过 ✅ | `pnpm audit --prod` 没有已知漏洞 ✅（2026-10-31 实测）；另起服务逐页打开、点「一键自动刷新评分」、保存投资逻辑，浏览器没有报错。

### 本轮已修复

| 问题 | 修复 |
|---|---|
| `pnpm audit --prod` 报 17 个已知漏洞：Next.js 16.3.2 有 5 个严重级（图片优化接口、`next/og` 等处的远程代码执行）和 2 个高危（图片优化的 SSRF、Server Actions 拒绝服务）；zod 4.4.3、sharp、source-map-js 各有高危 | Next.js 与 eslint-config-next 升到 16.4.3，zod 升到 4.6.7，sharp 随之到 0.35.5，source-map-js 到 1.2.2；顺带 vitest 4.1.12、drizzle-kit 0.31.11 |
| 没有登录，但 `next dev` / `next start` 默认监听所有网卡：同一局域网（比如公共 Wi-Fi）里的人能打开持仓页、改数据 | 两个命令默认只监听 127.0.0.1；要在手机上看需要显式加 `-H 0.0.0.0`（README「数据与隐私」） |
| L15：`fina_indicator` 请求了 `update_flag` 却不过滤 | 2026-10-30 已修（只留修正后的那条）。L15 的另一半「`fund_nav` 不返回 `adj_nav`」是误报：etf-trend 库里从 `fund_nav` 拉的 43,510 行都有 `adj_nav` |

### 仍未处理（截至 2026-10-31）

- **开发依赖里的 12 个已知漏洞**：vite 8.2.2（vitest 带的）、eslint 依赖链里的 brace-expansion / minimatch、drizzle-kit 与 tsx 带的旧版 esbuild。都只在本机跑测试、lint、迁移时用到，不对外监听；要清掉得升大版本或强行替换子依赖，可能弄坏工具链，暂不处理。
- **没有实际影响或影响很小**：L1（配置快照每次刷新重复插行）、L13（快照 createdAt 被覆盖）、L4、L5、L7、L18、M12、M16（性能），以及 L6、L9（配置和状态行不对用户开放）。
- **需要改表结构**：L10（手工评分与自动评分同一个键、互相覆盖）。手工评分只在当天没有自动数据时才有意义，暂按使用约定处理。
- **需要真实数据（用户本机）**：红利价值代理换成中证红利、港股互联网的估值数据、历史成分权重回填。

---

## 2026-10-30 真实数据复查

> 用真实 Tushare 数据做了一次全量回填（5 年行情、366 只成分股、约 7300 份财报），逐项核对四个资产桶当天的评分和体检。改完数据规则后，又不调 Tushare、用库里已存的个股财报离线重算了全部 2,156 行桶级汇总，和回填结果对账。

**当前基线**：`tsc --noEmit` ✅ | `eslint .` ✅ | `next build` ✅ | `vitest run` 44 个文件 / 301 个测试全部通过 ✅（2026-10-30 实测）。

### 本轮已修复

| 问题 | 怎么发现的 | 修复 |
|---|---|---|
| 盈利、营收同比的桶级汇总被小基数公司拉高：创业板指成分股 95 分位 +1386%，去极值后的加权均值 +128%，加权中位数 +42%。多数公司下滑时汇总仍可能为正，体检看不到恶化 | 真实数据回填 | 增长率改用加权中位数，ROE 仍用去极值均值 |
| 体检的「上一期」在财报季取到紧挨着最新点的那天，那天新财报已经占了不少权重，等于新财报和自己比（沪深300 取到 10-29 的 +18.18%，纯半年报时是 +26.17%）。半年报为正、三季报为负时，混合点可能已转负，会把一期为负误判成连续两期为负、提前暂停新增 | 真实数据回填 | 汇总记下主导报告期占有效权重的比例，上一期取那一期占比最高的点（相差不到 2 个百分点的取较新的）；评分页标出每个点以哪期财报为主 |
| 同一天发了年报和一季报的公司，汇总取哪份看数据返回顺序。按库里的顺序重算时，长江电力取成了 2025 年报，它的权重正好在中位数上，上证50 盈利同比从 +28.74% 变成 +6.17% | 离线重算对账（796 行对不上） | 同一天取报告期新的那份 |
| Tushare 对修正过的财报返回修正前后两条（`update_flag` 0 / 1），汇总用先读到的那条，入库留下的是后写的那条 | 修完上一条后还剩 44 行小差异 | 同一报告期、同一公告日只留 `update_flag = 1` 的 |

修完后再离线重算：报告期判断与回填结果完全一致；剩下 44 行差异都在小数点后两位（修正前后两条的差别），下一次真实刷新时只会留修正后的那条。

### 运维注意

- Tushare 一个 Token 最多同时用 10 个 IP。云端环境的出网 IP 一直在换，连跑两次全量回填后被限制（「您的IP数量超限」）。Tushare 只在固定 IP 的机器上跑。

---

## 2026-10-28 复查与修复状态

> 两路复查：一路逐项核对本文件里尚未关闭的中低危条目；一路对 v2 改动（`8ef4160..734513c`：默认配置、财报刷新、体检、投资逻辑、AI 新闻监控）做对抗式审查，多数问题用代码复现过。

**当前基线**：`tsc --noEmit` ✅ | `eslint .` ✅ | `next build` ✅ | `vitest run` 44 个文件 / 289 个测试全部通过 ✅（2026-10-28 实测）；另在浏览器里验证了编辑框连续保存和再平衡标签。

### 本轮已修复

| 问题 | 来源 | 修复 |
|---|---|---|
| 撤销误判或写完复核后，同一条新闻换个网站转载会让条件反复触发 | v2 复查（高） | 记下每条条件最近一次复核 / 撤销的日期：不晚于那天的事件只算相关；之后的新事件要有明确的事件日期才自动触发 |
| 没有发布日期的文章，模型从正文推出日期后仍可能自动触发 | v2 复查 | 自动触发要求文章发布日期已知且在 30 天内 |
| 三季报季的体检拿三季报去比一季报（截止日只隔 61 天，固定 80 天间隔取错期） | v2 复查 | 桶级汇总记下按权重占主导的报告期，体检按报告期找上一期；旧数据退回日期间隔，全量回填一次后补齐 |
| 过期的手工基本面判断盖住自动规则发现的恶化 | v2 复查 | 手工判断只在 180 天内替代自动体检 |
| 条件删掉后，它名下的「可能触发」永远挂着、没法处理 | v2 复查 | 删除 / 改写条件时一并忽略；提醒只数还能确认的；对应条件不在的也能「忽略」 |
| 编辑框不刷新就再保存，会把刚加的条件删掉再新建（关联的事件和新闻断开） | v2 复查 | 保存后用服务端返回的条件（带 id）更新编辑框；条件状态在别处变化时重新载入 |
| 公告日早于上次汇总、晚几天才进 Tushare 的财报永远并不进汇总 | v2 复查 | 增量刷新重算最近 30 天 |
| 模型初筛回复格式不对时，当天的文章全被当成「无关」标成看过 | v2 复查 | 这一轮失败、不标记扫描过，下一轮重试 |
| 财报刷新状态在数据入库前就记成功 | v2 复查 | 入库后再记 |
| 海外权益低于区间时显示「等待评分确认」（这个桶永远不打分） | v2 复查 | 不打分的桶显示「低于区间：新增资金优先补足」 |
| 上海 0–8 点写下的逻辑，季度复核早一天到期 | v2 复查 | 写下逻辑的时间先换成上海日期 |
| 「派生盈利增长无可用 PE 历史」把 Tushare 标成 DEGRADED | v2 复查 | 去掉（派生值 v2 起只作参考） |
| 每次自动刷新都删掉手工导入的股权风险溢价 | L11（比原报告更严重） | 清理只删非手工行 |
| `TUSHARE_MAX_RPM=` 留空会被当成每分钟 1 次 | M6 | 留空、非数字、≤ 0 都用默认值 |
| 手工导入的价格可以是 0 或负数，并永久盖过 Tushare 的值 | L8 | 价格、估值倍数必须大于 0，股息率不能为负 |
| 分红稳定性的注释说只算已实施的分红，代码没查 | L14 | 只算 `div_proc = 实施`（缺失的旧数据看派息日） |
| `GET /api/settings` 返回写死的默认值，与数据库不一致 | L17 | 读数据库，默认值另列在 `defaults` |
| 三个旧表单遇到网络错误或非 JSON 的 500 会整页报错，且隐藏服务端的字段错误 | L12 | 共用 `sendJson`：错误转成提示文字，422 显示具体字段错误 |
| worker 固定 6 小时一跳：笔记本休眠、重启后可能很久不刷新 | L16 + 新发现 | 每 30 分钟检查一次，按墙钟时间判断是否到期（失败后隔 1 小时再试），启动 5 秒后先查一次 |
| DeepSeek 默认开思考模式，「立即检查新闻」要等好几分钟；JSON 输出偶尔返回空 | 新发现 | 只有带正文复核开低强度思考，其余关闭；空回复重试一次 |

### 仍未处理

- **没有实际影响或影响很小**：L1（配置快照每次刷新重复插行）、L13（快照 createdAt 被覆盖）、L4、L5、L7、L18、M12、M16（性能），以及 L6、L9、L15（配置和状态行不对用户开放）。
- **需要改表结构**：L10（手工评分与自动评分同一个键、互相覆盖）。手工评分只在当天没有自动数据时才有意义，暂按使用约定处理。
- **需要真实数据验证**：红利价值代理换成中证红利、港股互联网的估值数据、历史成分权重回填（要有 Tushare Token 的环境）；DeepSeek 真实接口的第一次运行（要用户本机的 Key）。

---

## 2026-10-18 复查与修复状态

> 上面 2026-08-23 的报告是历史快照，行号、统计和部分结论已经过期（例如 H4 的“HIGH 不可达”在阈值改为 v1.1 的 3 年后已不成立）。本节是当前状态，阅读时请以本节为准。

**当前基线**：`tsc --noEmit` ✅ | `eslint .` ✅ | `next build` ✅ | `vitest run` 33 个文件 / 177 个测试全部通过 ✅（2026-10-18 实测）。

### 本轮已修复

| 问题 | 修复内容 |
|---|---|
| worker 启动即退出 | 去掉唯一 timer 的 `unref()`，抽出可测的 `scheduleNextTick`；`pnpm worker` 实测常驻，回归测试断言 `timer.hasRef()` |
| 增量刷新后财务基本面永久陈旧 | 派生盈利增长跨运行读取 DB 中的 `PRICE_CLOSE`/`PE_TTM` 历史并按 `available_at` 点内配对；TECH 改用 `PE_TTM`（v1.4 已无 forward PE 生产者）；派生为空显式告警 |
| 引擎没有数据龄期闸门 | 新增 `history.maxObservationAgeDays=180`：最新观察距评估日超限时组件可信度降 LOW（只降级、不改分数） |
| 单股/主题硬上限未进入决策状态 | `risk.ts` 增加主题聚合与每桶最高风险；评分刷新把硬上限违规注入状态机 → `OVERWEIGHT`（immediate）、`riskSeverity=CRITICAL`；持仓页与信号共用同一套标签 |
| 冷却/信号/决策日志在生产链路不可达 | 新增 `POST /api/decisions` 与决策表单；记录 ADD/REDUCE 后按日期比较实际生效 7 天冷却；评分刷新在状态变化或硬上限时写入 `signals`（fingerprint 去重，仅最新评估日） |
| 3 日确认不校验交易日连续 | 确认链改用 `PRICE_CLOSE` 观察日期构建的交易日历校验相邻性；全量回填的月频历史快照跳过逐日确认 |
| 手工评分可回填过去日期 | `asOf` 收紧为“必须是上海今天”，避免覆盖同日自动快照和污染候选链 |
| 回测仓位上限量纲错误 | `target` 与 `maxBps/minBps` 统一除以四桶目标合计；默认配置下不再出现 target 超 cap 被迫卖出 |
| 回测取价绕过点内时间/选源 | 新增 `pickPointInTimePrice`：`availableAt<=评估日` + 手工覆盖/主 Provider/quality/时间戳确定性优先级；新增“顺延前值”告警 |
| 回测“T+1”口径误导 | 明确为“下一个评估日（月末）收盘成交”，`signalLag=NEXT_EVALUATION_CLOSE`；落库评估网格与评分配置快照 |
| 回测边界 | 空净值曲线/空网格/单点指标、CLI `worstYear=null` 打印 `0.0%` 等问题修复；页面列名改为“调仓桶次” |
| 配置 `REFRESH_TOKEN` 后页面按钮必然 401 | 刷新/回测按钮改走同源 server action；API 仍保留 Bearer 校验供外部 cron 使用 |

### 原报告条目现状

- **已修复**：H1、H2、H3、H4、H5、H6、H8、M1、M2、M3、M5、M8、M19、M20，以及大部分 L 项（行号已变，需重新定位）。
- **部分修复**：H7——派生兜底已能跨运行读 PE 历史、TECH 改用 PE_TTM，但真实财报增量刷新仍未实现（依赖 180 天新鲜度闸门兜底，不会再用陈旧数据输出增配）。
- **明确保留（未在本次范围）**：WGC 流量的 `availableAt` 仍为保守假设（建议以真实发布日复核）；历史财务/分红稳定性回填仍使用当前成分权重（幸存者偏差，点内历史成分回填待做）；回测为“下一评估日”而非逐日 T+1；设置页的目标仓位/风险上限仍只读；E2E 尚未补齐；Decision Log 的 30/90/180 天结果回填未做。

### 本轮验证方式

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过；`pnpm worker` 常驻实测；用数据库副本启动生产构建，冒烟验证 dashboard/scores/holdings/backtest/decisions/data-status/settings/onboarding 页面 200、`POST/GET /api/decisions` 正常、配置 `REFRESH_TOKEN` 后刷新/回测 API 返回 401 且页面照常渲染（真实 `data/hengcang.db` 未被写入）。

---

## 问题统计

| 严重度 | 数量 |
|---|---|
| 🔴 高危 | 8 |
| 🟠 中危 | 20 |
| 🟡 低危 | 18 |

---

## 一、🔴 高危问题

### H1. 编辑/删除持仓可把全站弄成永久 500(预留资金不变式失守)
- **位置**:`src/server/portfolio-service.ts:70-77`;抛错点 `src/domain/portfolio.ts:23-28`
- **问题**:`updateHolding`/`deleteHolding` 应用变更前不重验组合不变式。settings 的 PATCH 会校验"预留资金 ≤ 现金与债券桶",但持仓写路径完全不校验。
- **复现**:预留资金 ¥1000、仅一笔现金持仓 ¥1000 → 改小市值/改桶/删除该持仓 → 此后 `summarizePortfolio` 每次抛「预留资金不能超过现金与债券桶的当前金额」→ dashboard / scores / 手工评分 / 导入提交**全部依赖 `getPortfolioView()`,集体 500,只能手改数据库恢复**。
- **加重**:导入提交路由(`app/api/data/import/commit/route.ts:33-34`)先落库观察值再重算评分,炸在后面 → 数据已持久化但接口报 500。
- **修复方向**:写路径重跑预留资金校验返回 409/422;或 `summarizePortfolio` 不抛错,钳制扣除额并暴露警告标志让读取端降级。

### H2. /api/data/refresh 的令牌鉴权是从未生效的死代码【实测验证】
- **位置**:`app/api/data/refresh/route.ts:7-27`
- **问题(经本地起服实测)**:Next.js 16.3.2 中 `new URL(request.url).hostname` **无论请求来自哪个网卡/Host 头是什么,恒等于 "localhost"**(实测伪造 Host 头与走局域网 IP 均如此)。因此 `!isLocalRequest(request)` 恒为 false,Authorization 比较分支永远不可达——配置了 REFRESH_TOKEN 也**不构成任何认证**,无令牌 POST 直接 200 并执行完整刷新。叠加:仓库现行 .env.local 根本未定义 REFRESH_TOKEN(fail-open)。
- **影响**:任何能访问端口的人(局域网/隧道/反代)都能循环触发数分钟级的 Tushare/FRED 全量扇出——配额烧毁、数据扰动、事件循环负载。
- **修复方向**:不要用 request.url 判定;要么配置了令牌就一律要求 Bearer(个人工具最简),要么比对 socket 远端地址/x-forwarded-for 是否回环;令牌比较用常量时间;未配置令牌时启动告警或拒绝外网可达。

### H3. 整个支柱缺失时评分被静默重加权,仍输出"强增配 + 高可信度"
- **位置**:`scoring/engine.ts:97-101` + `scoring/models.ts:44-68`
- **问题**:文档承诺固定 50%便宜+30%基本面+20%趋势。当一整根支柱缺失(如无价格序列→趋势三项全 null):顶层 combineComponents 重加权为 62.5/37.5/0;覆盖率恰=0.8 而判定是 `< highCoverage(0.8)`,边界相等不降级→置信度取来源值 **HIGH**;applyRiskRules 只拦 null 与 LOW→输出 **STRONG_ADD_ALLOWED、allowAdd=true**。
- **已验证复现**:VALUE_DIVIDEND 缺价格历史→cheapness 70/fundamental 97/trend null→机会分 80.1,HIGH,强增配。手工导入不含价格数据的 CSV 即可触达。missingMetrics 列出了缺失项但没有逻辑消费它拦截增配。
- **修复方向**:任一顶层支柱缺失按 LOW_CONFIDENCE 处理(或封顶 HOLD);重权仅允许发生在指标级而非支柱级。

### H4. 差一天的边界:按文档回填 5 年数据,HIGH 置信度永远不可达
- **位置**:`percentile.ts:35,39`
- **问题**:years = Δms/(365.25 天) 且要求 years >= 5。规格自己的回填窗口(20210823→20260823)含闰日=1826 天=**4.9993 年 < 5**→所有干净自动指标永远 MEDIUM。
- **连锁后果**:engine.ts:64-65 把 MEDIUM 封顶在 LIGHT_ADD_ALLOWED——标准数据上**引擎永远发不出 STRONG_ADD_ALLOWED**,最高档整体失效,系统性不可见偏差。
- **修复方向**:改日历年差比较或加容差;补"干净 5 年序列→HIGH"回归测试(全套件目前没有任何断言产出 HIGH 的用例)。

### H5. "3 个交易日确认"状态机跨刷新不成立
- **位置**:`scoring-refresh-service.ts:66-96` + `state.ts:22-24` + `scoring-service.ts:47-57`
- **缺陷**:①候选史取最近 2 条快照但不校验日期连续性,快照按刷新次数而非交易日计(盘中刷两次双倍计数,断档拉长);②previousCandidate 在缺 candidateState 时回退到已确认态,手工快照污染确认链;③隐式契约"喂 N-1 条"被调用方硬编码 limit(2)——确认天数调到 4 则**所有状态转换静默冻结**;④saveManualScore 完全绕开确认流程,普通候选态即时落库为最终态。
- **修复方向**:候选史带日期由 domain 判交易日连续;limit 从 config 推导;手工路径走同一状态机。

### H6. 单股/主题 ETF 8%/15% 硬上限是从未接线的死代码
- **位置**:`domain/risk.ts:23-46`(仅测试引用)、`schema.ts:77-83`(risk_limits 只被设置页展示)、app/** grep 确认 OVERWEIGHT 从未出现
- **问题**:规格案例 B(单股 12%>8%→OVERWEIGHT)只存在于 domain 函数和测试里;自动评分只比较桶权重 vs 分配目标 maxBps;themeBps 无任何消费者。用户看到的上限**没有任何代码执行**。domain API 分母由调用方自选(规格 §9.2 要求可投资资产)正是漂移缝隙。
- **修复方向**:把 evaluateHoldingRisk 接进评分/持仓流(分母=investableAssetsMinor),或删除死代码停止暗示已实现。

### H7. derivedEarningsGrowth 是永远跑不通的死路径,盈利增长静默缺失
- **位置**:`automatic-data-refresh-service.ts:40-50,58,149`
- **问题**:要求当前批次 ≥252 个前置 PE 点,但采样上限≈82 点(月频回填 61+当月直连 22;增量仅 1 天)→恒返回空。增量模式(日常默认)下 EARNINGS_GROWTH/INDEX_EARNINGS_GROWTH 兜底从未生效且**无任何警告**。
- **修复方向**:基于 DB 全序列计算或窗口匹配实际采样密度;删除则明示放弃兜底。

### H8. PATCH 持仓会静默重置字段;空补丁通过校验【实测验证】
- **位置**:`lib/validation.ts:23-25` + `holdings/[id]/route.ts:7-13` + `portfolio-service.ts:70-73`
- **问题(zod 4.4.3 实测)**:.partial() 后 ZodDefault 仍然生效——safeParse({}) **成功**并产生 region/currency/isSingleStock/isThematicEtf/isApproximate/needsBreakdown 六个默认键;只改名一个字段的补丁也携带这六个键。refine(Object.keys>0) 是死代码。后果:**改个名就把 约数/待拆分 标志重置为 false**,仪表盘的"股票账户需要拆分"风险提示无声消失。
- **修复方向**:补丁 schema 用显式 optional 字段(不含 default),只应用原始 body 中出现的键;加"PATCH {} 返回 422、改名不动布尔列"的测试。

---

## 二、🟠 中危问题

| # | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| M1 | gold-etf-flow.ts:10 | NAV Map 仅按日期建键,默认两只 ETF 同日互相覆盖→A 基金份额变动乘 B 基金净值,GOLD_ETF_FLOW_3M 系统性算错(单基金测试掩盖) | 按 symbol+date 配对;补双基金测试 |
| M2 | shared.ts:22-24 + fred/twelve-data | fetchJson 非 2xx 直接 throw 不解析 body→FRED(400)/TwelveData(429) 的 PERMISSION_DENIED/RATE_LIMITED 结构化码不可达,消费端分支永假,违反 README Provider 规则第 3 条 | !ok 时解析 body,按 provider 映射 |
| M3 | tushare/index.ts:53-58,286 | 真实限流文案"每分钟最多访问该接口N次"不含 频次/limit 关键词→归 UPSTREAM_ERROR,且 shouldRetry 恒真 250ms 重打两次放大封禁 | 匹配真实文案;权限错误不重试 |
| M4 | tushare/index.ts 全部查询 | 无分页无截断检测:全市场 daily_basic ≈5400 行逼近上限;代理指数配成中证全指必截断→静默入库标 VALID | 翻页循环+封顶页检测降级 PARTIAL |
| M5 | worker.ts + refresh.ts:34 | setInterval 无重叠锁(回填超时或休眠唤醒叠加运行→SQLite 竞争);每 tick 动态 import 泄漏模块图;失败吞栈;refresh.ts 顶层 process.exitCode=1 被 worker 启动 import 后**退出码永久非 0** | 自调度循环+in-flight 锁+信号处理 |
| M6 | rate-limiter.ts:16-17,26-33 | 环境变量不校验:TUSHARE_MAX_RPM=""→0→acquire 死循环挂起;重试退避期间占用并发槽位;limiter 进程内独立,dev+worker 双进程实际 2× 配额 | 校验钳位;跨进程协调 |
| M7 | manual-import.ts:41-42 vs observation-repository.ts:55 | observedAt/availableAt 宽松 Date.parse("2026-8-9" 可过),下游 slice(0,10) 字典序比较→该行在自己 asOf 当天被静默排除出评分 | 严格 ISO 校验或预览时归一化 |
| M8 | observation-repository.ts:114-147 vs schema.ts:130-139 | 手工 upsert 按 asOf 查存在,唯一索引却不含 asOf→特定重复输入触发约束冲突,**整个导入事务回滚**,报裸 SQLite 500 | 统一唯一策略+约束错误转行级 Issue |
| M9 | validation.ts:32 + scoring-service.ts:61-82 | 手工评分任意 asOf:未来日期快照永久占据榜首;过去日期直接覆盖同日自动评分,不受确认流程约束 | asOf ≤ 今天(上海时区) |
| M10 | models.ts:17-30 + input-builder.ts:16 | PARTIAL 直分指标(分红稳定性 30% 权重、央行购金)绕过 v1.1 "PARTIAL 最高中可信度",组件置信度给 HIGH | directComponent 按 quality 封顶 |
| M11 | default-config.json:24-25 | 置信度年限阈值两个规格各取一半:MEDIUM 用 v1.1 的 1 年、HIGH 用 v1.0 的 5 年(v1.1 规定 ≥3 年即可)→3–4 年干净序列被判 MEDIUM | 定权威版本,显式 highYears/mediumYears |
| M12 | fred/index.ts:50 | availableAt:=realtime_start,未请求 vintage 语义→早于甚至远早于 observedAt,破坏 README 明确保留的无前视回测元数据 | 发布滞后或 ALFRED vintage |
| M13 | automatic-data-refresh-service.ts:145,152 | FRED 失败计入共享 warnings 使 tushare 显示 DEGRADED,fred 凭环境变量存在就标 READY——责任倒挂 | 按 provider 分桶记录 |
| M14 | holding-form.tsx:31、manual-score-form.tsx:26 | toISOString().slice(0,10) 是 UTC 日期:北京时间 00:00–08:00 保存的是昨天;且 (portfolioId,bucket,asOf) 是评分快照唯一键,早晨录入挂错日期快照 | 复用 shanghaiDate 助手 |
| M15 | holdings/page.tsx:12-22,28,43-44 | 文案说"集中度按总资产计算"实现却用可投资资产;预留资金逐笔扣除规则视图层手工复刻(第三种 bps 实现)→漂移温床 | 下沉 summarizePortfolio;文案对齐 |
| M16 | 性能四连 | provider 串行扇出(~1000+ 次串行调用);resolveSeries 每指标每桶全量重载历史去重;十万行级观察值逐行 SELECT+INSERT 单同步事务阻塞事件循环;≤10MB 导入同步解析卡死单进程 | 受控并发;窗口查询;批量 upsert |
| M17 | index-weight-cache.ts:23-31 | 权重快照无时效上限:上游停更后聚合永远基于过期成分名单照标 VALID | 返回 effectiveDate,超龄降级 |
| M18 | holdings/[id]/route.ts:8 等 4 处 | request.json() 裸调用:畸形 JSON 报 500 而非 400(import 路由已示范正确写法 INVALID_JSON) | 提取 parseJsonBody 助手统一 400 |
| M19 | reserved-cash-form.tsx:14 | initialYuan=(Number(minor)/100).toFixed(0):¥0.50 显示成 "1",打开设置直接点保存→**存储值被纯显示往返从 ¥0.50 改成 ¥1.00**;大数超 Number 安全整数 | 从字符串/BigInt 直接格式化 |
| M20 | portfolio-service.ts:51-67 + client.ts:22 | 未 seed 的新库上新增持仓:portfolios 行不存在,FOREIGN KEY constraint failed 未捕获→用户第一次交互就裸 500(settings PATCH 却处理了这个情况) | createHolding 内按需 upsert 默认组合或友好 409 |

---

## 三、🟡 低危问题

| # | 位置 | 问题 |
|---|---|---|
| L1 | scoring-refresh-service.ts:37-44 | config_snapshots 每次刷新插新行(自动刷新一轮 ~4 行重复),全年上千行噪音,无清理;首个 bucket build 抛错还会留下孤儿快照 |
| L2 | models.ts:68 → engine.ts:44 | 熔断门槛消费舍入后覆盖率:0.5999 存成 0.6 通过 60% 门槛武装熔断——安全规则被展示层舍入污染 |
| L3 | portfolio.ts / risk.ts / holdings 页 | bps 计算三种舍入并存;单持仓占比用截断除法,行合计与桶权重对不上;超配判定消费舍入后桶 bps 有亚 bps 假阴性 |
| L4 | percentile.ts:18 | 百分位自包含:最低值得分=100/N 而非 0,N≈60 时全体分数向中间偏移 ~1.7 分(spec 注明生产版可再处理,应显式注释) |
| L5 | derive-price-features.ts:67 + models.ts:78 | DERIVED 来源趋势组件 confidence 缺省 HIGH,历史指标 derived 却封顶 MEDIUM,口径不一 |
| L6 | config.ts:27-52 | assertScoringConfig 不查负权重;positionLimits 小数 vs 引擎 bps 且引擎从不读它——单位陷阱 |
| L7 | models.ts:71-110 | 无前视只对 MetricSeries 强制;PointMetric/directScore 无 asOf≤评估日校验——对未来回测执行器是边界隐患 |
| L8 | manual-import.ts:39 | 负号放行且只有 scoreRange 指标查范围:PRICE_CLOSE=-5 可入库毒化动量/乖离符号 |
| L9 | observation-repository.ts:150-162 | manual 状态更新 UPDATE-only,未 seed 的库静默不生效(seed.ts 已缓解) |
| L10 | scoring-service vs scoring-refresh-service | 手工/自动快照同键 last-writer-wins 互踢;auto SET 漏 valuationScore/riskPenalty(当前恒 null/0,潜在分歧) |
| L11 | automatic-data-refresh-service.ts:52-57 | removeInvalidLegacyRealYield 每次刷新全表 DELETE tushare 旧利率——应一次性迁移而非常驻热路径 |
| L12 | 三个客户端表单 | yuanToMinor 两处复制粘贴、>2 位小数静默截断;response.json() 无 try/catch(断网/代理 HTML 时状态卡"保存中…"且 unhandled rejection);holding-form 吞掉服务端结构化 422 字段错误恒显通用文案;成功后不清空输入易重复提交 |
| L13 | db/schema.ts:167-190 | score_snapshots 只有 createdAt 且 upsert 覆盖它,无法追溯首建时间 |
| L14 | dividend-stability.ts:9-11 | 注释称只计实施/完成记录但 div_proc 从未校验;非实施行虚增年度分红计数 |
| L15 | tushare/index.ts:93-95,232-242 | fund_nav 的 fields 请求 adj_nav(该端点不返回,在 fund_adj)——当前未被代理使用但是地雷;fina_indicator 请求 update_flag 却不过滤,每次修订各存一条 |
| L16 | worker.ts:1 | 启动静态 import 副作用导致开机立即刷一次(文档未说明);twelve-data 返回原生倒序未归一、时间戳硬编码 |
| L17 | app/api/settings/route.ts:15-17 | GET /api/settings 返回硬编码默认值而设置页读 DB——一旦 DB 阈值被编辑,API 与 UI 数字不一致 |
| L18 | validation.ts:29 vs manual-score-form.tsx:47 | 服务端接受小数 cheapnessScore(无 .int())而客户端 step="1"——手搓请求能存 UI 无法产生的 50.5 |

---

## 四、✅ 做得好的地方(经交叉验证)

- **无前视纪律(MetricSeries 层面)真实有效**:asOf 与 availableAt 双闸门;同源修订按"评估日前最新可用版本"选择且有集成测试
- **指数加权数学正确**:PE/PB/PS 加权调和平均 Σw/Σ(w/x)、股息率加权算术平均、部分覆盖重归一、winsorize 保序对齐
- **金额全程 bigint 最小单位**,zod 正则挡住负数/非法格式,唯一浮点转换仅在展示层
- **幂等性成立**:Tushare 观察值时间戳由交易日期确定性派生,重跑走 UPDATE;score 快照 upsert 冲突目标与唯一索引精确一致
- **手工覆盖优先级**以 rank=10000 在读取侧生效,provider 物理上无法覆盖手工行
- 导入提交 digest 防 TOCTOU;CSV 解析器正确处理引号/BOM/别名;rate limiter 滑窗核心无竞态;fetchJson 全链路 12s AbortController;ECharts 正确 dispose+ResizeObserver 断开;密钥无日志泄漏,.env.local 已 gitignore 且不在 git 历史
- **缓存治理正确**:所有 DB 页面 force-dynamic,所有变更组件 router.refresh(),无 Next Data Cache 陈旧路径;全库无 dangerouslySetInnerHTML XSS 汇点
- Provider 合规:结构化失败 + fallbackAllowed ✓、不触碰 isManualOverride ✓、拒绝伪造宏观序列 ✓

## 五、测试盲区(解释了上述问题为何能存活)

1. 无任何断言产出 HIGH 置信度的用例 → H4 隐身
2. 无缺支柱引擎级测试,missingMetrics 从未被断言 → H3 隐身
3. PARTIAL 上限只在组件层测过,未穿过 calculateAssetScore → M10 隐身
4. 确认流程缺抖动用例 [LAA,HOLD,LAA]、方向不匹配冷却、REDUCE 方向、immediate 进出 OVERWEIGHT
5. portfolio.test.ts 不测错误路径 → H1 隐身
6. gold-etf-flow 测试只用单基金 → M1 隐身;rate limiter 零测试 → M6 隐身;PATCH {} 行为零测试 → H8 隐身
7. 服务编排层(automatic-data-refresh-service)几乎零覆盖,恰是高危最密集处

## 六、建议修复批次

| 批次 | 内容 | 理由 |
|---|---|---|
| **P0 立即** | H2 refresh 鉴权、H1 持仓不变式、H8 PATCH 重置 | 一个安全洞、一个挂全站、一个静默丢风险标志,改动都很小 |
| **P1 本周** | H3 支柱缺失、H4 HIGH 边界、H5 确认链 | 直接决定对外输出的投资建议正确性 |
| **P2 次周** | H6 上限接线、H7 盈利增长、M1 NAV 配对、M2/M3 错误映射、M19 显示往返改值 | 补齐宣称能力与数据质量 |
| **P3 随后** | 其余中危 + 批次化性能改造(M16) | 稳健性与体验 |
| **持续** | 低危随触随修;按第五节补测试盲区 | 防回归 |

## 附录:方法、验证与局限

- domain 层结论经对真实代码编写临时脚本执行复现;H8 经本会话独立复跑 zod safeParse 证实;H2 由子代理本地起服并用伪造 Host 头/局域网 IP 实测证实;
- 子代理验证 H2 时曾用仓库配置的真实 Tushare Token 触发数次刷新(均为当日幂等更新,~1808 行 update、无 insert),测试服务器已关闭、临时文件已清理、.env.local 已还原;
- 涉及外部 API 行为的论断(FRED realtime_start 默认值、Tushare 限流文案、TwelveData 429 形态)基于官方文档行为推断,落地修复时建议以真实调用复核;
- 子代理报告中的两条论断经人工复核后修正:"updateHolding 无 404 语义"不成立(路由层已处理);"manual 状态行 UPDATE-only"的影响已被 seed.ts 缓解;
- 本地 .env.local 含真实 TUSHARE_TOKEN:确认未被 git 追踪且不在历史中,但因多次明文使用,建议轮换。
