CREATE TABLE `index_constituent_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`index_symbol` text NOT NULL,
	`effective_date` text NOT NULL,
	`constituent_symbol` text NOT NULL,
	`weight` real NOT NULL,
	`provider` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_constituent_snapshot_unique` ON `index_constituent_snapshots` (`index_symbol`,`effective_date`,`constituent_symbol`);--> statement-breakpoint
CREATE INDEX `index_constituent_snapshot_lookup_idx` ON `index_constituent_snapshots` (`index_symbol`,`effective_date`);--> statement-breakpoint
DROP INDEX `metric_observation_unique`;--> statement-breakpoint
ALTER TABLE `metric_observations` ADD `metadata_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `metric_observation_unique` ON `metric_observations` (`subject_type`,`subject_id`,`metric_key`,`provider`,`observed_at`,`available_at`);