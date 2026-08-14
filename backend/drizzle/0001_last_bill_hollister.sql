ALTER TABLE `task_files` DROP INDEX `task_files_file_unique`;--> statement-breakpoint
CREATE INDEX `task_files_file_idx` ON `task_files` (`file_id`);