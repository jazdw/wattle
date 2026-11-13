CREATE TABLE `transaction_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transaction_ranges_account` ON `transaction_ranges` (`household_id`,`account_id`);--> statement-breakpoint
-- Backfill: the days each source's transactions already stored cover. Overlapping rows are fine (they're merged when read).
-- Imports: each run of consecutive imported days with imported transactions in it (an import writes exactly its file's days).
INSERT INTO `transaction_ranges` (`id`, `household_id`, `account_id`, `source`, `from`, `to`, `recorded_at`)
SELECT lower(hex(randomblob(16))), `household_id`, `account_id`, 'import', `start`, `last`, CAST((julianday('now') - 2440587.5) * 86400000 AS integer)
FROM (
	SELECT `household_id`, `account_id`, min(`date`) AS `start`, max(`date`) AS `last`
	FROM (
		SELECT `household_id`, `account_id`, `date`, julianday(`date`) - row_number() OVER (PARTITION BY `account_id` ORDER BY `date`) AS `run`
		FROM `account_daily`
		WHERE `source` = 'import'
	)
	GROUP BY `household_id`, `account_id`, `run`
) `island`
-- A run without (a balances file's, or one imported before imports kept their transactions).
WHERE EXISTS (SELECT 1 FROM `transactions` `kept` WHERE `kept`.`account_id` = `island`.`account_id` AND `kept`.`source` = 'import' AND `kept`.`date` BETWEEN `island`.`start` AND `island`.`last`);--> statement-breakpoint
-- Bank reports, from the replies kept: each account's days are the report's day (New York's, roughly) less the days it has.
INSERT INTO `transaction_ranges` (`id`, `household_id`, `account_id`, `source`, `from`, `to`, `recorded_at`)
SELECT lower(hex(randomblob(16))), `account`.`household_id`, `account`.`id`, 'report', date(`reply`.`generated`, '-' || `reply`.`days` || ' days'), `reply`.`generated`, CAST((julianday('now') - 2440587.5) * 86400000 AS integer)
FROM (
	SELECT `response`.`household_id`, `response`.`connection_id`, json_extract(`entry`.`value`, '$.account_id') AS `external_id`, json_extract(`entry`.`value`, '$.days_available') AS `days`,
		date(json_extract(`response`.`body`, '$.report.date_generated'), '-5 hours') AS `generated`
	FROM `plaid_responses` `response`, json_each(`response`.`body`, '$.report.items') `item`, json_each(`item`.`value`, '$.accounts') `entry`
	WHERE `response`.`endpoint` = '/asset_report/get'
) `reply`
JOIN `accounts` `account` ON `account`.`household_id` = `reply`.`household_id` AND `account`.`connection_id` = `reply`.`connection_id` AND `account`.`external_id` = `reply`.`external_id`
JOIN `connections` `connection` ON `connection`.`id` = `account`.`connection_id`
WHERE `reply`.`days` IS NOT NULL AND `reply`.`generated` IS NOT NULL AND `account`.`is_hidden` = 0
	-- Investment accounts' history comes from their own transactions, not the report.
	AND NOT (`connection`.`has_investments` = 1 AND `account`.`type` = 'investment');--> statement-breakpoint
-- A report's account without a reply kept: its report transactions' first day to their last.
INSERT INTO `transaction_ranges` (`id`, `household_id`, `account_id`, `source`, `from`, `to`, `recorded_at`)
SELECT lower(hex(randomblob(16))), `household_id`, `account_id`, 'report', min(`date`), max(`date`), CAST((julianday('now') - 2440587.5) * 86400000 AS integer)
FROM `transactions` `txn`
WHERE `source` = 'report' AND NOT EXISTS (SELECT 1 FROM `transaction_ranges` `range` WHERE `range`.`account_id` = `txn`.`account_id` AND `range`.`source` = 'report')
GROUP BY `household_id`, `account_id`;--> statement-breakpoint
-- Plaid's investment transactions: each account's first to its latest synced day (else its last transaction).
INSERT INTO `transaction_ranges` (`id`, `household_id`, `account_id`, `source`, `from`, `to`, `recorded_at`)
SELECT lower(hex(randomblob(16))), `household_id`, `account_id`, 'plaid', `first`, max(`first`, coalesce(`synced`, `last`)), CAST((julianday('now') - 2440587.5) * 86400000 AS integer)
FROM (
	SELECT `txn`.`household_id`, `txn`.`account_id`, min(`txn`.`date`) AS `first`, max(`txn`.`date`) AS `last`,
		(SELECT max(`daily`.`date`) FROM `account_daily` `daily` WHERE `daily`.`account_id` = `txn`.`account_id` AND `daily`.`source` = 'snapshot') AS `synced`
	FROM `transactions` `txn`
	WHERE `txn`.`source` = 'plaid'
	GROUP BY `txn`.`household_id`, `txn`.`account_id`
);
