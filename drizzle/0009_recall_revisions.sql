CREATE TABLE `recall_build_state` (
	`build_id` varchar(191) NOT NULL,
	`asset_id` varchar(36) NOT NULL,
	`desired_revision` bigint unsigned NOT NULL,
	`indexed_revision` bigint unsigned,
	`content_hash` varchar(64),
	`status` enum('queued','running','done','failed','deleted') NOT NULL DEFAULT 'queued',
	`error_message` text,
	`indexed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `recall_build_state_build_id_asset_id_pk` PRIMARY KEY(`build_id`,`asset_id`)
);
--> statement-breakpoint
CREATE TABLE `recall_builds` (
	`build_id` varchar(191) NOT NULL,
	`physical_index` varchar(255) NOT NULL,
	`manifest_json` json NOT NULL,
	`manifest_hash` varchar(64) NOT NULL,
	`write_enabled` boolean NOT NULL DEFAULT true,
	`status` enum('building','ready','active','retired') NOT NULL DEFAULT 'building',
	`backfill_cursor` varchar(36),
	`backfill_completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `recall_builds_build_id` PRIMARY KEY(`build_id`),
	CONSTRAINT `recall_build_index_unique` UNIQUE(`physical_index`)
);
--> statement-breakpoint
CREATE TABLE `recall_sources` (
	`asset_id` varchar(36) NOT NULL,
	`asset_kind` enum('public','private') NOT NULL,
	`source_revision` bigint unsigned NOT NULL,
	`source_hash` varchar(64) NOT NULL,
	`deleted` boolean NOT NULL DEFAULT false,
	`snapshot_json` json,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `recall_sources_asset_id` PRIMARY KEY(`asset_id`)
);
--> statement-breakpoint
ALTER TABLE `recall_build_state` ADD CONSTRAINT `recall_build_state_build_id_recall_builds_build_id_fk` FOREIGN KEY (`build_id`) REFERENCES `recall_builds`(`build_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `recall_build_status_idx` ON `recall_build_state` (`build_id`,`status`);