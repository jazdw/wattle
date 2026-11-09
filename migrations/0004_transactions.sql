CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`type` text,
	`subtype` text,
	`description` text,
	`security_id` text,
	`quantity` real DEFAULT 0 NOT NULL,
	`price` real,
	`fees` integer,
	`kind` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_external` ON `transactions` (`account_id`,`source`,`external_id`);
--> statement-breakpoint
CREATE INDEX `transactions_household_external` ON `transactions` (`household_id`,`source`,`external_id`);
--> statement-breakpoint
CREATE INDEX `transactions_account_date` ON `transactions` (`household_id`,`account_id`,`date`,`id`);
--> statement-breakpoint
CREATE INDEX `transactions_household_date` ON `transactions` (`household_id`,`date`,`id`);
--> statement-breakpoint
-- Plaid's investment transactions and the bank reports' transactions, moved as they are (their tables are dropped next).
INSERT INTO `transactions` (`id`, `household_id`, `account_id`, `source`, `external_id`, `date`, `amount`, `currency`, `type`, `subtype`, `description`, `security_id`, `quantity`, `price`, `fees`, `created_at`)
SELECT `id`, `household_id`, `account_id`, 'plaid', coalesce(`external_id`, `id`), `date`, `amount`, `currency`, `type`, `subtype`, `name`, `security_id`, `quantity`, `price`, `fees`, strftime('%s', 'now') * 1000
FROM `investment_transactions`;--> statement-breakpoint
INSERT INTO `transactions` (`id`, `household_id`, `account_id`, `source`, `external_id`, `date`, `amount`, `currency`, `description`, `created_at`)
SELECT `id`, `household_id`, `account_id`, 'report', `external_id`, `date`, `amount`, `currency`, `description`, `created_at`
FROM `bank_transactions`;
--> statement-breakpoint
DROP TABLE `bank_transactions`;--> statement-breakpoint
DROP TABLE `investment_transactions`;
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`out_id` text NOT NULL,
	`in_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`out_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`in_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_pair` ON `transfers` (`out_id`,`in_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_out_linked` ON `transfers` (`out_id`) WHERE status in ('auto', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_in_linked` ON `transfers` (`in_id`) WHERE status in ('auto', 'confirmed');--> statement-breakpoint
CREATE INDEX `transfers_household` ON `transfers` (`household_id`,`status`);
