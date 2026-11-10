-- A Quicken file's MEMO, kept beside its NAME (the description) as the file has it.
ALTER TABLE `transactions` ADD `memo` text;--> statement-breakpoint
-- An imported transaction that is this one (Plaid's or a report's, dated a day or two apart): set null when the import's row goes.
ALTER TABLE `transactions` ADD `replaced_by` text REFERENCES transactions(id) ON DELETE set null;
