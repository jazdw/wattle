CREATE TABLE `snapshot_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`date` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`accounts` integer DEFAULT 0 NOT NULL,
	`holdings` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_runs_started` ON `snapshot_runs` (`household_id`,`started_at`);