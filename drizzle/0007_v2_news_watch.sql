CREATE TABLE `news_items` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`site_name` text,
	`published_on` text,
	`summary` text NOT NULL,
	`verdict` text NOT NULL,
	`breaker_id` text,
	`evidence` text,
	`authority` integer,
	`event_id` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`found_at` text NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `holding_theses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`breaker_id`) REFERENCES `thesis_breakers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`event_id`) REFERENCES `thesis_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_items_thesis_url_unique` ON `news_items` (`thesis_id`,`url`);--> statement-breakpoint
CREATE INDEX `news_items_thesis_idx` ON `news_items` (`thesis_id`,`found_at`);--> statement-breakpoint
ALTER TABLE `holding_theses` ADD `news_queries_json` text;--> statement-breakpoint
ALTER TABLE `holding_theses` ADD `news_queries_basis` text;--> statement-breakpoint
ALTER TABLE `holding_theses` ADD `news_scanned_at` text;--> statement-breakpoint
ALTER TABLE `thesis_events` ADD `origin` text DEFAULT 'MANUAL' NOT NULL;