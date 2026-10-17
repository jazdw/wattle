CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`date` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`households` integer NOT NULL,
	`errors` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_started` ON `job_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `price_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`calls` text NOT NULL,
	`saved` integer NOT NULL,
	`changes` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `price_runs_started` ON `price_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`action` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`plaid_calls` text NOT NULL,
	`counts` text NOT NULL,
	`changes` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_connection_started` ON `sync_runs` (`household_id`,`connection_id`,`started_at`);