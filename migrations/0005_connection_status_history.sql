ALTER TABLE `connections` ADD `status_observed_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `consent_warning_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `history_as_of` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `history_stale_at` integer;