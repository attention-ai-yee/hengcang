ALTER TABLE `portfolios` ADD `reserved_cash_minor` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `score_snapshots` ADD `cheapness_score` real;--> statement-breakpoint
ALTER TABLE `score_snapshots` ADD `allow_add` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `score_snapshots` ADD `force_sell` integer DEFAULT false NOT NULL;