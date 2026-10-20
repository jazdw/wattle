ALTER TABLE `connections` ADD `has_investments` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `has_balance_history` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing logins: each had the one product its Link button asked for.
UPDATE `connections` SET `has_investments` = true WHERE `kind` = 'investments';--> statement-breakpoint
UPDATE `connections` SET `has_balance_history` = true, `kind` = 'account' WHERE `kind` = 'banking';
