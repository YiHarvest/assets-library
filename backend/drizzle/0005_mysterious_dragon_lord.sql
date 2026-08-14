ALTER TABLE `jobs` MODIFY COLUMN `type` enum('validate','transcode','split','analyze','finalize','embed','publish','update','retry','delete','callback','cleanup') NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dedupe_key` varchar(191);--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_dedupe_key_unique` UNIQUE(`dedupe_key`);