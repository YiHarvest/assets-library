CREATE INDEX `task_files_video_source_idx` ON `task_files` (`video_source_id`);--> statement-breakpoint
ALTER TABLE `task_files` DROP INDEX `task_files_video_source_unique`;
