CREATE TABLE `plaid_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`run_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_id` text,
	`received_at` integer NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plaid_responses_connection` ON `plaid_responses` (`household_id`,`connection_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `plaid_responses_received` ON `plaid_responses` (`received_at`);--> statement-breakpoint
ALTER TABLE `holdings` ADD `price_at` integer;--> statement-breakpoint
ALTER TABLE `securities` ADD `plaid_close` real;--> statement-breakpoint
ALTER TABLE `securities` ADD `plaid_close_date` text;