ALTER TABLE `account_daily` ADD `price_source` text;--> statement-breakpoint
ALTER TABLE `account_daily` ADD `unmatched` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `holding_daily` ADD `price_source` text;--> statement-breakpoint
ALTER TABLE `holding_daily` ADD `unmatched` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Where each row came from, from the old source and estimated flag (shared/quality.ts).
-- Balances: a rebuilt investment balance that was estimated hit a gap in its transactions.
UPDATE `account_daily` SET `unmatched` = 1 WHERE `source` = 'backfill' AND `estimated` = 1 AND `account_id` IN (SELECT `id` FROM `accounts` WHERE `type` = 'investment');--> statement-breakpoint
UPDATE `account_daily` SET `source` = CASE
  WHEN `source` = 'backfill' THEN 'rebuilt'
  WHEN `source` = 'sync' AND `estimated` = 1 THEN 'carried'
  WHEN `source` = 'sync' THEN 'snapshot'
  ELSE `source` END;--> statement-breakpoint
-- Holdings: an estimated synced price is provisional within the repricing week, an institution's stand-in before it.
UPDATE `holding_daily` SET `price_source` = CASE
  WHEN `price` IS NULL THEN NULL
  WHEN `estimated` = 0 THEN 'close'
  WHEN `source` = 'sync' AND `date` >= date('now', '-7 days') THEN 'provisional'
  ELSE 'institution' END;--> statement-breakpoint
UPDATE `holding_daily` SET `source` = CASE
  WHEN `source` = 'backfill' THEN 'rebuilt'
  WHEN `source` = 'sync' THEN 'snapshot'
  ELSE `source` END;--> statement-breakpoint
ALTER TABLE `account_daily` DROP COLUMN `estimated`;--> statement-breakpoint
ALTER TABLE `holding_daily` DROP COLUMN `estimated`;
