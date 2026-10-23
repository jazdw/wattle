CREATE TABLE `db_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`rows_written` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `connections` ADD `holdings_fetched_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `transactions_fetched_at` integer;