CREATE INDEX `jobs_household_status` ON `jobs` (`household_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_household_started` ON `jobs` (`household_id`,`started_at`);