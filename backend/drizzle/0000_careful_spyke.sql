CREATE TABLE `analysis_results` (
	`asset_id` varchar(36) NOT NULL,
	`result_json` json NOT NULL,
	`model_protocol` varchar(64) NOT NULL,
	`model_name` varchar(255) NOT NULL,
	`completed_at` datetime(3) NOT NULL,
	`indexed_at` datetime(3),
	`index_error` text,
	CONSTRAINT `analysis_results_asset_id` PRIMARY KEY(`asset_id`)
);
--> statement-breakpoint
CREATE TABLE `asset_tags` (
	`asset_id` varchar(36) NOT NULL,
	`tag_id` varchar(36) NOT NULL,
	`source` enum('model','human') NOT NULL,
	`confidence` double,
	CONSTRAINT `asset_tags_asset_id_tag_id_pk` PRIMARY KEY(`asset_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36),
	`task_file_id` varchar(36),
	`video_source_id` varchar(36),
	`media_object_id` varchar(36) NOT NULL,
	`cover_object_id` varchar(36),
	`user_id` varchar(191),
	`file_name` varchar(255) NOT NULL,
	`media_type` enum('image','video') NOT NULL,
	`description` text NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`width` int unsigned,
	`height` int unsigned,
	`duration_ms` bigint unsigned,
	`segment_start_ms` bigint unsigned,
	`segment_end_ms` bigint unsigned,
	`segment_order` int unsigned,
	`status` enum('queued','running','failed','pending_review','done') NOT NULL DEFAULT 'queued',
	`phase` enum('uploading','processing','pending_review','published','expired') NOT NULL DEFAULT 'processing',
	`error_code` varchar(64),
	`error_message` text,
	`error_details` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `assets_video_segment_unique` UNIQUE(`video_source_id`,`segment_order`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36),
	`file_id` varchar(36),
	`video_source_id` varchar(36),
	`type` enum('validate','transcode','split','analyze','embed','publish','update','retry','delete','callback','cleanup') NOT NULL,
	`status` enum('queued','running','done','failed') NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`payload` json,
	`available_at` datetime(3) NOT NULL,
	`locked_at` datetime(3),
	`error_message` text,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `media_objects` (
	`id` varchar(36) NOT NULL,
	`bucket` varchar(63) NOT NULL,
	`object_key` varchar(512) NOT NULL,
	`public_url` varchar(2048) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`storage_class` enum('temporary','permanent') NOT NULL DEFAULT 'temporary',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `media_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `media_bucket_key_unique` UNIQUE(`bucket`,`object_key`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` varchar(36) NOT NULL,
	`value` varchar(128) NOT NULL,
	`normalized_value` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `tags_normalized_unique` UNIQUE(`normalized_value`)
);
--> statement-breakpoint
CREATE TABLE `task_files` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`file_id` varchar(36),
	`video_source_id` varchar(36),
	`upload_object_id` varchar(36),
	`file_name` varchar(255) NOT NULL,
	`media_type` enum('image','video') NOT NULL,
	`size_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`status` enum('queued','running','failed','pending_review','done') NOT NULL DEFAULT 'queued',
	`phase` enum('uploading','processing','pending_review','published','expired') NOT NULL DEFAULT 'uploading',
	`error_code` varchar(64),
	`error_message` text,
	`error_details` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `task_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_files_task_ordinal_unique` UNIQUE(`task_id`,`ordinal`),
	CONSTRAINT `task_files_file_unique` UNIQUE(`file_id`),
	CONSTRAINT `task_files_video_source_unique` UNIQUE(`video_source_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(36) NOT NULL,
	`type` enum('upload','publish','update','retry','delete') NOT NULL,
	`status` enum('queued','running','failed','pending_review','done') NOT NULL DEFAULT 'queued',
	`phase` enum('uploading','processing','pending_review','published','expired') NOT NULL DEFAULT 'processing',
	`user_id` varchar(191),
	`callback_url` varchar(2048),
	`auto_publish` boolean NOT NULL DEFAULT false,
	`total_files` int unsigned NOT NULL DEFAULT 0,
	`done_files` int unsigned NOT NULL DEFAULT 0,
	`failed_files` int unsigned NOT NULL DEFAULT 0,
	`error_code` varchar(64),
	`error_message` text,
	`error_details` json,
	`callback_attempts` int unsigned NOT NULL DEFAULT 0,
	`next_callback_at` datetime(3),
	`callback_completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`purge_at` datetime(3),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_sources` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36),
	`user_id` varchar(191),
	`source_object_id` varchar(36),
	`file_name` varchar(255) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`duration_ms` bigint unsigned,
	`status` enum('queued','running','failed','pending_review','done') NOT NULL DEFAULT 'queued',
	`phase` enum('uploading','processing','pending_review','published','expired') NOT NULL DEFAULT 'uploading',
	`error_code` varchar(64),
	`error_message` text,
	`error_details` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `video_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_task_file_id_task_files_id_fk` FOREIGN KEY (`task_file_id`) REFERENCES `task_files`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_video_source_id_video_sources_id_fk` FOREIGN KEY (`video_source_id`) REFERENCES `video_sources`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_media_object_id_media_objects_id_fk` FOREIGN KEY (`media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_cover_object_id_media_objects_id_fk` FOREIGN KEY (`cover_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_file_id_assets_id_fk` FOREIGN KEY (`file_id`) REFERENCES `assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_video_source_id_video_sources_id_fk` FOREIGN KEY (`video_source_id`) REFERENCES `video_sources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_video_source_id_video_sources_id_fk` FOREIGN KEY (`video_source_id`) REFERENCES `video_sources`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_upload_object_id_media_objects_id_fk` FOREIGN KEY (`upload_object_id`) REFERENCES `media_objects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_sources` ADD CONSTRAINT `video_sources_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_sources` ADD CONSTRAINT `video_sources_source_object_id_media_objects_id_fk` FOREIGN KEY (`source_object_id`) REFERENCES `media_objects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `assets_user_phase_created_idx` ON `assets` (`user_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_phase_media_created_idx` ON `assets` (`phase`,`media_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_video_source_idx` ON `assets` (`video_source_id`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `jobs_task_idx` ON `jobs` (`task_id`);--> statement-breakpoint
CREATE INDEX `media_storage_created_idx` ON `media_objects` (`storage_class`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_files_task_status_idx` ON `task_files` (`task_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_status_created_idx` ON `tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_user_phase_created_idx` ON `tasks` (`user_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_purge_idx` ON `tasks` (`purge_at`);--> statement-breakpoint
CREATE INDEX `video_sources_task_idx` ON `video_sources` (`task_id`);--> statement-breakpoint
CREATE INDEX `video_sources_user_created_idx` ON `video_sources` (`user_id`,`created_at`);
