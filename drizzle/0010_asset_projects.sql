ALTER TABLE `private_assets` ADD `project_id` varchar(36);--> statement-breakpoint
ALTER TABLE `public_assets` ADD `project_id` varchar(36);--> statement-breakpoint
ALTER TABLE `tasks` ADD `project_id` varchar(36);--> statement-breakpoint
CREATE INDEX `private_assets_project_user_created_idx` ON `private_assets` (`project_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_assets_project_created_idx` ON `public_assets` (`project_id`,`created_at`);--> statement-breakpoint
CREATE OR REPLACE ALGORITHM = undefined
SQL SECURITY definer
VIEW `asset_entries` AS (
  select 'public' as kind, id, project_id, null as user_id, uploader_user_id,
    null as public_asset_id, task_id, task_item_id, task_item_segment_id,
    video_source_id, media_object_id, thumbnail_media_object_id, segment_index,
    segment_start_ms, segment_end_ms, name, description, media_type,
    original_filename, original_path, mime_type, size_bytes, processing_status,
    review_status, failure_code, failure_message, created_at, updated_at, deleted_at
  from public_assets
  union all
  select 'private' as kind, id, project_id, user_id, null as uploader_user_id,
    public_asset_id, task_id, task_item_id, task_item_segment_id,
    video_source_id, media_object_id, thumbnail_media_object_id, segment_index,
    segment_start_ms, segment_end_ms, name, description, media_type,
    original_filename, original_path, mime_type, size_bytes, processing_status,
    review_status, failure_code, failure_message,
    created_at, updated_at, deleted_at
  from private_assets
);