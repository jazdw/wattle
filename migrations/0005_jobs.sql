CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`group_id` text,
	`waits_for` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` integer NOT NULL,
	`locked_until` integer,
	`lock_token` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`result` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_group` ON `jobs` (`group_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_waits_for` ON `jobs` (`waits_for`);--> statement-breakpoint
CREATE INDEX `jobs_household` ON `jobs` (`household_id`,`created_at`);