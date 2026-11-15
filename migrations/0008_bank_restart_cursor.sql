ALTER TABLE `connections` ADD `bank_restart_cursor` text;--> statement-breakpoint
-- Logins whose paging loop the first version left part-way (still loading,
-- with a cursor from inside the loop): restart from the beginning if the
-- data changes, where every such loop began. Re-read pages change nothing.
UPDATE `connections` SET `bank_restart_cursor` = '' WHERE `bank_feed` = 'loading' AND `bank_cursor` IS NOT NULL;
