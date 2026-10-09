CREATE TABLE `account_daily` (
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`balance` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`account_id`, `date`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_daily_household_date` ON `account_daily` (`household_id`,`date`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`source` text NOT NULL,
	`connection_id` text,
	`external_id` text,
	`name` text NOT NULL,
	`official_name` text,
	`institution_name` text,
	`mask` text,
	`type` text NOT NULL,
	`subtype` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`owner_user_id` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`category` text,
	`balance` integer,
	`balance_as_of` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `accounts_household` ON `accounts` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_external` ON `accounts` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `allowed_emails` (
	`email` text PRIMARY KEY NOT NULL,
	`household_id` text,
	`note` text,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`owner_user_id` text,
	`provider` text DEFAULT 'plaid' NOT NULL,
	`external_id` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`institution_id` text,
	`institution_name` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error_code` text,
	`consent_expires_at` integer,
	`last_synced_at` integer,
	`txn_synced_through` text,
	`backfill_status` text DEFAULT 'pending' NOT NULL,
	`asset_report_token_enc` text,
	`asset_report_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `connections_household` ON `connections` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_external` ON `connections` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `fx_daily` (
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`date` text NOT NULL,
	`rate` real NOT NULL,
	PRIMARY KEY(`base`, `quote`, `date`)
);
--> statement-breakpoint
CREATE TABLE `holding_daily` (
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`security_id` text NOT NULL,
	`date` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real,
	`value` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`account_id`, `security_id`, `date`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `holding_daily_household_date` ON `holding_daily` (`household_id`,`date`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`security_id` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real,
	`price_as_of` text,
	`value` integer NOT NULL,
	`cost_basis` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `security_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `holdings_household` ON `holdings` (`household_id`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `user_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_user` ON `household_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_currency` text DEFAULT 'USD' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investment_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`security_id` text,
	`date` text NOT NULL,
	`name` text,
	`type` text NOT NULL,
	`subtype` text,
	`quantity` real DEFAULT 0 NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`price` real,
	`fees` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inv_txn_account_date` ON `investment_transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `inv_txn_household` ON `investment_transactions` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inv_txn_external` ON `investment_transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `kv_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prices_daily` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`external_id` text,
	`ticker` text,
	`name` text,
	`type` text,
	`subtype` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`classification` text,
	`classification_source` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`last_price` real,
	`last_price_date` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `securities_household` ON `securities` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `securities_external` ON `securities` (`household_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `securities_ticker` ON `securities` (`household_id`,`ticker`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `targets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`weights` text NOT NULL,
	`band_pct` real DEFAULT 5 NOT NULL,
	`excluded_account_ids` text DEFAULT '[]' NOT NULL,
	`excluded_categories` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `targets_household` ON `targets` (`household_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`picture` text,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);