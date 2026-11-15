ALTER TABLE `connections` ADD `bank_feed` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `bank_feed_error` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `bank_cursor` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `plaid_category` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `plaid_category_detailed` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `plaid_category_confidence` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_name` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_channel` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `authorized_date` text;--> statement-breakpoint
CREATE INDEX `transactions_replaced_by` ON `transactions` (`replaced_by`);