CREATE TABLE `allocation_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`asset_bucket` text NOT NULL,
	`target_bps` integer NOT NULL,
	`min_bps` integer NOT NULL,
	`max_bps` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allocation_target_bucket_unique` ON `allocation_targets` (`portfolio_id`,`asset_bucket`);--> statement-breakpoint
CREATE TABLE `backtest_results` (
	`id` text PRIMARY KEY NOT NULL,
	`backtest_run_id` text NOT NULL,
	`cagr_bps` integer,
	`max_drawdown_bps` integer,
	`volatility_bps` integer,
	`sharpe_milli` integer,
	`turnover_bps` integer,
	`trade_count` integer,
	`series_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`backtest_run_id`) REFERENCES `backtest_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`strategy` text NOT NULL,
	`status` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`transaction_cost_bps` integer NOT NULL,
	`inputs_json` text NOT NULL,
	`config_snapshot_id` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_snapshot_id`) REFERENCES `config_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `config_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`version` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `data_source_status` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer NOT NULL,
	`status` text NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_message` text,
	`capabilities_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_source_status_provider_unique` ON `data_source_status` (`provider`);--> statement-breakpoint
CREATE TABLE `decision_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`holding_id` text,
	`asset_bucket` text NOT NULL,
	`decided_at` text NOT NULL,
	`action` text NOT NULL,
	`direction` text NOT NULL,
	`rationale` text NOT NULL,
	`score_snapshot_json` text NOT NULL,
	`allocation_snapshot_json` text NOT NULL,
	`system_state` text NOT NULL,
	`outcome_30d_json` text,
	`outcome_90d_json` text,
	`outcome_180d_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`instrument_id` text,
	`name` text NOT NULL,
	`symbol` text,
	`instrument_type` text NOT NULL,
	`asset_bucket` text NOT NULL,
	`region` text DEFAULT 'CN' NOT NULL,
	`theme` text,
	`quantity` text,
	`cost_basis_minor` text,
	`market_value_minor` text NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`is_single_stock` integer DEFAULT false NOT NULL,
	`is_thematic_etf` integer DEFAULT false NOT NULL,
	`is_approximate` integer DEFAULT false NOT NULL,
	`needs_breakdown` integer DEFAULT false NOT NULL,
	`manual_value_locked` integer DEFAULT true NOT NULL,
	`as_of` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `holdings_portfolio_idx` ON `holdings` (`portfolio_id`);--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text,
	`name` text NOT NULL,
	`instrument_type` text NOT NULL,
	`asset_bucket` text NOT NULL,
	`region` text DEFAULT 'CN' NOT NULL,
	`theme` text,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`is_single_stock` integer DEFAULT false NOT NULL,
	`is_thematic_etf` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_symbol_unique` ON `instruments` (`symbol`);--> statement-breakpoint
CREATE TABLE `metric_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`value` text NOT NULL,
	`unit` text NOT NULL,
	`provider` text NOT NULL,
	`observed_at` text NOT NULL,
	`available_at` text NOT NULL,
	`as_of` text NOT NULL,
	`fetched_at` text NOT NULL,
	`quality` text DEFAULT 'VALID' NOT NULL,
	`is_manual_override` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_observation_unique` ON `metric_observations` (`subject_type`,`subject_id`,`metric_key`,`provider`,`observed_at`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_currency` text DEFAULT 'CNY' NOT NULL,
	`onboarding_completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`provider` text NOT NULL,
	`observed_at` text NOT NULL,
	`available_at` text NOT NULL,
	`as_of` text NOT NULL,
	`fetched_at` text NOT NULL,
	`open` text,
	`high` text,
	`low` text,
	`close` text NOT NULL,
	`volume` text,
	`currency` text NOT NULL,
	`quality` text DEFAULT 'VALID' NOT NULL,
	`is_manual_override` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_observation_unique` ON `price_observations` (`instrument_id`,`provider`,`observed_at`);--> statement-breakpoint
CREATE INDEX `price_observation_as_of_idx` ON `price_observations` (`as_of`);--> statement-breakpoint
CREATE TABLE `risk_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`single_stock_bps` integer DEFAULT 800 NOT NULL,
	`thematic_etf_bps` integer DEFAULT 1500 NOT NULL,
	`theme_bps` integer DEFAULT 2000 NOT NULL,
	`cooldown_days` integer DEFAULT 7 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `score_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`asset_bucket` text NOT NULL,
	`as_of` text NOT NULL,
	`valuation_score` integer,
	`fundamental_score` integer,
	`trend_score` integer,
	`opportunity_score` integer,
	`risk_penalty` integer DEFAULT 0 NOT NULL,
	`confidence` text NOT NULL,
	`recommendation_state` text NOT NULL,
	`risk_severity` text DEFAULT 'INFO' NOT NULL,
	`components_json` text NOT NULL,
	`config_snapshot_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_snapshot_id`) REFERENCES `config_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_snapshot_unique` ON `score_snapshots` (`portfolio_id`,`asset_bucket`,`as_of`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`asset_bucket` text,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`signal_type` text NOT NULL,
	`old_state` text,
	`new_state` text,
	`summary` text NOT NULL,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signals_portfolio_created_idx` ON `signals` (`portfolio_id`,`created_at`);