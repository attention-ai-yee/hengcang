CREATE TABLE `holding_theses` (
	`id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text NOT NULL,
	`holding_id` text NOT NULL,
	`thesis` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holding_thesis_holding_unique` ON `holding_theses` (`holding_id`);--> statement-breakpoint
CREATE TABLE `thesis_breakers` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`triggered_at` text,
	`triggered_by_event_id` text,
	`last_reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `holding_theses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thesis_breakers_thesis_idx` ON `thesis_breakers` (`thesis_id`);--> statement-breakpoint
CREATE TABLE `thesis_events` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_on` text NOT NULL,
	`summary` text NOT NULL,
	`source_url` text,
	`breaker_id` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `holding_theses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`breaker_id`) REFERENCES `thesis_breakers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `thesis_events_thesis_idx` ON `thesis_events` (`thesis_id`,`recorded_at`);