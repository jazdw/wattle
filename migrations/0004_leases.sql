CREATE TABLE `leases` (
	`key` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`holder` text,
	`until` integer,
	`note_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `plaid_name` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `holdings_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `targets` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `sync_lease_until`;--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `resync_requested_at`;--> statement-breakpoint
ALTER TABLE `connections` DROP COLUMN `backfill_started_at`;