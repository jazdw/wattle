ALTER TABLE `connections` ADD `sync_lease_until` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `resync_requested_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `backfill_started_at` integer;--> statement-breakpoint
ALTER TABLE `price_runs` ADD `outcome` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `price_runs` ADD `error` text;--> statement-breakpoint
ALTER TABLE `price_runs` ADD `note` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `note` text;