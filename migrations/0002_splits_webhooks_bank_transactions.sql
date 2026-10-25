CREATE TABLE `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_transactions_external` ON `bank_transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `bank_transactions_account_date` ON `bank_transactions` (`household_id`,`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `plaid_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`event` text NOT NULL,
	`received_at` integer NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plaid_webhooks_connection` ON `plaid_webhooks` (`household_id`,`connection_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `plaid_webhooks_received` ON `plaid_webhooks` (`received_at`);--> statement-breakpoint
ALTER TABLE `prices_daily` ADD `split_factor` real;