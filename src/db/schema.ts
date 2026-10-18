import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const portfolios = sqliteTable("portfolios", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("CNY"),
  reservedCashMinor: text("reserved_cash_minor").notNull().default("0"),
  onboardingCompletedAt: text("onboarding_completed_at"),
  ...timestamps,
});

export const instruments = sqliteTable(
  "instruments",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol"),
    name: text("name").notNull(),
    instrumentType: text("instrument_type").notNull(),
    assetBucket: text("asset_bucket").notNull(),
    region: text("region").notNull().default("CN"),
    theme: text("theme"),
    currency: text("currency").notNull().default("CNY"),
    isSingleStock: integer("is_single_stock", { mode: "boolean" }).notNull().default(false),
    isThematicEtf: integer("is_thematic_etf", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("instruments_symbol_unique").on(table.symbol)],
);

export const holdings = sqliteTable(
  "holdings",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    instrumentId: text("instrument_id").references(() => instruments.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    symbol: text("symbol"),
    instrumentType: text("instrument_type").notNull(),
    assetBucket: text("asset_bucket").notNull(),
    region: text("region").notNull().default("CN"),
    theme: text("theme"),
    quantity: text("quantity"),
    costBasisMinor: text("cost_basis_minor"),
    marketValueMinor: text("market_value_minor").notNull(),
    currency: text("currency").notNull().default("CNY"),
    isSingleStock: integer("is_single_stock", { mode: "boolean" }).notNull().default(false),
    isThematicEtf: integer("is_thematic_etf", { mode: "boolean" }).notNull().default(false),
    isApproximate: integer("is_approximate", { mode: "boolean" }).notNull().default(false),
    needsBreakdown: integer("needs_breakdown", { mode: "boolean" }).notNull().default(false),
    manualValueLocked: integer("manual_value_locked", { mode: "boolean" }).notNull().default(true),
    asOf: text("as_of").notNull(),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [index("holdings_portfolio_idx").on(table.portfolioId)],
);

export const allocationTargets = sqliteTable(
  "allocation_targets",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    assetBucket: text("asset_bucket").notNull(),
    targetBps: integer("target_bps").notNull(),
    minBps: integer("min_bps").notNull(),
    maxBps: integer("max_bps").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("allocation_target_bucket_unique").on(table.portfolioId, table.assetBucket)],
);

export const riskLimits = sqliteTable("risk_limits", {
  id: text("id").primaryKey(),
  portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  singleStockBps: integer("single_stock_bps").notNull().default(800),
  thematicEtfBps: integer("thematic_etf_bps").notNull().default(1500),
  themeBps: integer("theme_bps").notNull().default(2000),
  cooldownDays: integer("cooldown_days").notNull().default(7),
  ...timestamps,
});

export const priceObservations = sqliteTable(
  "price_observations",
  {
    id: text("id").primaryKey(),
    instrumentId: text("instrument_id").notNull().references(() => instruments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    observedAt: text("observed_at").notNull(),
    availableAt: text("available_at").notNull(),
    asOf: text("as_of").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    open: text("open"),
    high: text("high"),
    low: text("low"),
    close: text("close").notNull(),
    volume: text("volume"),
    currency: text("currency").notNull(),
    quality: text("quality").notNull().default("VALID"),
    isManualOverride: integer("is_manual_override", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("price_observation_unique").on(table.instrumentId, table.provider, table.observedAt),
    index("price_observation_as_of_idx").on(table.asOf),
  ],
);

export const metricObservations = sqliteTable(
  "metric_observations",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    metricKey: text("metric_key").notNull(),
    value: text("value").notNull(),
    unit: text("unit").notNull(),
    provider: text("provider").notNull(),
    observedAt: text("observed_at").notNull(),
    availableAt: text("available_at").notNull(),
    asOf: text("as_of").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    quality: text("quality").notNull().default("VALID"),
    metadataJson: text("metadata_json"),
    isManualOverride: integer("is_manual_override", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("metric_observation_unique").on(
      table.subjectType,
      table.subjectId,
      table.metricKey,
      table.provider,
      table.observedAt,
      table.availableAt,
    ),
  ],
);

export const indexConstituentSnapshots = sqliteTable(
  "index_constituent_snapshots",
  {
    id: text("id").primaryKey(),
    indexSymbol: text("index_symbol").notNull(),
    effectiveDate: text("effective_date").notNull(),
    constituentSymbol: text("constituent_symbol").notNull(),
    weight: real("weight").notNull(),
    provider: text("provider").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    uniqueIndex("index_constituent_snapshot_unique").on(table.indexSymbol, table.effectiveDate, table.constituentSymbol),
    index("index_constituent_snapshot_lookup_idx").on(table.indexSymbol, table.effectiveDate),
  ],
);

export const configSnapshots = sqliteTable("config_snapshots", {
  id: text("id").primaryKey(),
  portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const scoreSnapshots = sqliteTable(
  "score_snapshots",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    assetBucket: text("asset_bucket").notNull(),
    asOf: text("as_of").notNull(),
    valuationScore: integer("valuation_score"),
    cheapnessScore: real("cheapness_score"),
    fundamentalScore: integer("fundamental_score"),
    trendScore: integer("trend_score"),
    opportunityScore: integer("opportunity_score"),
    riskPenalty: integer("risk_penalty").notNull().default(0),
    confidence: text("confidence").notNull(),
    recommendationState: text("recommendation_state").notNull(),
    allowAdd: integer("allow_add", { mode: "boolean" }).notNull().default(false),
    forceSell: integer("force_sell", { mode: "boolean" }).notNull().default(false),
    riskSeverity: text("risk_severity").notNull().default("INFO"),
    componentsJson: text("components_json").notNull(),
    configSnapshotId: text("config_snapshot_id").references(() => configSnapshots.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("score_snapshot_unique").on(table.portfolioId, table.assetBucket, table.asOf)],
);

export const signals = sqliteTable(
  "signals",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    assetBucket: text("asset_bucket"),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").notNull(),
    signalType: text("signal_type").notNull(),
    oldState: text("old_state"),
    newState: text("new_state"),
    summary: text("summary").notNull(),
    isDuplicate: integer("is_duplicate", { mode: "boolean" }).notNull().default(false),
    acknowledgedAt: text("acknowledged_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("signals_portfolio_created_idx").on(table.portfolioId, table.createdAt)],
);

export const decisionLogs = sqliteTable("decision_logs", {
  id: text("id").primaryKey(),
  portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  holdingId: text("holding_id").references(() => holdings.id, { onDelete: "set null" }),
  assetBucket: text("asset_bucket").notNull(),
  decidedAt: text("decided_at").notNull(),
  action: text("action").notNull(),
  direction: text("direction").notNull(),
  rationale: text("rationale").notNull(),
  scoreSnapshotJson: text("score_snapshot_json").notNull(),
  allocationSnapshotJson: text("allocation_snapshot_json").notNull(),
  systemState: text("system_state").notNull(),
  outcome30dJson: text("outcome_30d_json"),
  outcome90dJson: text("outcome_90d_json"),
  outcome180dJson: text("outcome_180d_json"),
  createdAt: text("created_at").notNull(),
});

export const dataSourceStatus = sqliteTable("data_source_status", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  status: text("status").notNull(),
  lastAttemptAt: text("last_attempt_at"),
  lastSuccessAt: text("last_success_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  capabilitiesJson: text("capabilities_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const backtestRuns = sqliteTable("backtest_runs", {
  id: text("id").primaryKey(),
  portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
  strategy: text("strategy").notNull(),
  status: text("status").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  transactionCostBps: integer("transaction_cost_bps").notNull(),
  /** 同一次「运行回测」产出的所有策略行共享一个批次号，页面按批次分组展示最新一次 */
  batchId: text("batch_id"),
  inputsJson: text("inputs_json").notNull(),
  configSnapshotId: text("config_snapshot_id").references(() => configSnapshots.id),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
});

export const backtestResults = sqliteTable("backtest_results", {
  id: text("id").primaryKey(),
  backtestRunId: text("backtest_run_id").notNull().references(() => backtestRuns.id, { onDelete: "cascade" }),
  totalReturnBps: integer("total_return_bps"),
  cagrBps: integer("cagr_bps"),
  maxDrawdownBps: integer("max_drawdown_bps"),
  volatilityBps: integer("volatility_bps"),
  sharpeMilli: integer("sharpe_milli"),
  worstYearBps: integer("worst_year_bps"),
  longestDrawdownDays: integer("longest_drawdown_days"),
  turnoverBps: integer("turnover_bps"),
  tradeCount: integer("trade_count"),
  seriesJson: text("series_json").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * 持仓级投资逻辑（v2，docs/hengcang_v2_allocation_fundamentals_thesis.md §4）：
 * 每个持仓一份「投资逻辑 + 失效条件」。消息以带日期和来源的事件记录，
 * 事件对应到某条失效条件即触发它——该持仓暂停新增，写完复核才能解除。
 */
export const holdingTheses = sqliteTable(
  "holding_theses",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    holdingId: text("holding_id").notNull().references(() => holdings.id, { onDelete: "cascade" }),
    thesis: text("thesis").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("holding_thesis_holding_unique").on(table.holdingId)],
);

export const thesisBreakers = sqliteTable(
  "thesis_breakers",
  {
    id: text("id").primaryKey(),
    thesisId: text("thesis_id").notNull().references(() => holdingTheses.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    /** 表单里的顺序（从 0 起）。同一次保存的条目 createdAt 相同，不能靠它排序 */
    position: integer("position").notNull().default(0),
    /** ACTIVE：监控中；TRIGGERED：已被事件触发，等待复核 */
    status: text("status").notNull().default("ACTIVE"),
    triggeredAt: text("triggered_at"),
    triggeredByEventId: text("triggered_by_event_id"),
    lastReviewedAt: text("last_reviewed_at"),
    ...timestamps,
  },
  (table) => [index("thesis_breakers_thesis_idx").on(table.thesisId)],
);

export const thesisEvents = sqliteTable(
  "thesis_events",
  {
    id: text("id").primaryKey(),
    thesisId: text("thesis_id").notNull().references(() => holdingTheses.id, { onDelete: "cascade" }),
    /** NEWS：消息 / 事件；REVIEW：复核结论 */
    kind: text("kind").notNull(),
    /** 事件发生日（YYYY-MM-DD，上海时区），不晚于记录当天 */
    occurredOn: text("occurred_on").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: text("source_url"),
    breakerId: text("breaker_id").references(() => thesisBreakers.id, { onDelete: "set null" }),
    /** 记录时间（点内时间：后来补记的旧消息不会改写当时的状态） */
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [index("thesis_events_thesis_idx").on(table.thesisId, table.recordedAt)],
);
