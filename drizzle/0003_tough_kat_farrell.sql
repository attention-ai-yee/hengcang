ALTER TABLE `backtest_results` ADD `total_return_bps` integer;--> statement-breakpoint
ALTER TABLE `backtest_results` ADD `worst_year_bps` integer;--> statement-breakpoint
ALTER TABLE `backtest_results` ADD `longest_drawdown_days` integer;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `batch_id` text;