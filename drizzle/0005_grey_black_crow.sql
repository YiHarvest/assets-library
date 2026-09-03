CREATE TABLE `private_assets` (
	`id` varchar(36) NOT NULL,
	`public_asset_id` varchar(36),
	`user_id` varchar(191) NOT NULL,
	`task_id` varchar(36),
	`task_item_id` varchar(36),
	`task_item_segment_id` varchar(36),
	`video_source_id` varchar(36),
	`media_object_id` varchar(36),
	`thumbnail_media_object_id` varchar(36),
	`segment_index` int unsigned,
	`segment_start_ms` bigint unsigned,
	`segment_end_ms` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`media_type` enum('image','video') NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`original_path` varchar(1024) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`processing_status` enum('queued','validating','analyzing','completed','failed') NOT NULL DEFAULT 'queued',
	`failure_code` varchar(64),
	`failure_message` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`deleted_at` datetime(3),
	CONSTRAINT `private_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `private_assets_public_asset_unique` UNIQUE(`public_asset_id`),
	CONSTRAINT `private_assets_task_segment_unique` UNIQUE(`task_item_segment_id`),
	CONSTRAINT `private_assets_source_segment_unique` UNIQUE(`video_source_id`,`segment_index`)
);
--> statement-breakpoint
CREATE TABLE `public_assets` (
	`id` varchar(36) NOT NULL,
	`uploader_user_id` varchar(191),
	`task_id` varchar(36),
	`task_item_id` varchar(36),
	`task_item_segment_id` varchar(36),
	`video_source_id` varchar(36),
	`media_object_id` varchar(36),
	`thumbnail_media_object_id` varchar(36),
	`segment_index` int unsigned,
	`segment_start_ms` bigint unsigned,
	`segment_end_ms` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`media_type` enum('image','video') NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`original_path` varchar(1024) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` bigint unsigned NOT NULL,
	`processing_status` enum('queued','validating','analyzing','completed','failed') NOT NULL DEFAULT 'queued',
	`failure_code` varchar(64),
	`failure_message` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`deleted_at` datetime(3),
	`review_status` enum('pending_review','published','deleted') NOT NULL DEFAULT 'pending_review',
	CONSTRAINT `public_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_assets_task_segment_unique` UNIQUE(`task_item_segment_id`),
	CONSTRAINT `public_assets_source_segment_unique` UNIQUE(`video_source_id`,`segment_index`)
);
--> statement-breakpoint
ALTER TABLE `analysis_results` ADD `id` varchar(36);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD `public_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD `private_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD `id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD `public_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD `private_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD `id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD `public_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD `private_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `jobs` ADD `public_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `jobs` ADD `private_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD `id` varchar(36);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD `public_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD `private_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `video_sources` ADD `public_media_object_id` varchar(36);--> statement-breakpoint
ALTER TABLE `video_sources` ADD `private_media_object_id` varchar(36);--> statement-breakpoint
UPDATE `analysis_results` SET `id` = UUID() WHERE `id` IS NULL;--> statement-breakpoint
UPDATE `asset_tag_rejections` SET `id` = UUID() WHERE `id` IS NULL;--> statement-breakpoint
UPDATE `asset_tags` SET `id` = UUID() WHERE `id` IS NULL;--> statement-breakpoint
UPDATE `search_index_state` SET `id` = UUID() WHERE `id` IS NULL;--> statement-breakpoint
ALTER TABLE `analysis_results` DROP PRIMARY KEY, MODIFY COLUMN `id` varchar(36) NOT NULL, MODIFY COLUMN `asset_id` varchar(36), ADD PRIMARY KEY(`id`), ADD CONSTRAINT `analysis_results_legacy_asset_unique` UNIQUE(`asset_id`);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` DROP PRIMARY KEY, MODIFY COLUMN `id` varchar(36) NOT NULL, MODIFY COLUMN `asset_id` varchar(36), ADD PRIMARY KEY(`id`), ADD CONSTRAINT `asset_tag_rejections_legacy_unique` UNIQUE(`asset_id`,`category`,`normalized_value`);--> statement-breakpoint
ALTER TABLE `asset_tags` DROP PRIMARY KEY, MODIFY COLUMN `id` varchar(36) NOT NULL, MODIFY COLUMN `asset_id` varchar(36), ADD PRIMARY KEY(`id`), ADD CONSTRAINT `asset_tags_legacy_unique` UNIQUE(`asset_id`,`tag_id`);--> statement-breakpoint
ALTER TABLE `search_index_state` DROP PRIMARY KEY, MODIFY COLUMN `id` varchar(36) NOT NULL, MODIFY COLUMN `asset_id` varchar(36), ADD PRIMARY KEY(`id`), ADD CONSTRAINT `search_index_legacy_asset_unique` UNIQUE(`asset_id`);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_public_asset_unique` UNIQUE(`public_asset_id`);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_private_asset_unique` UNIQUE(`private_asset_id`);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD CONSTRAINT `asset_tag_rejections_public_unique` UNIQUE(`public_asset_id`,`category`,`normalized_value`);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD CONSTRAINT `asset_tag_rejections_private_unique` UNIQUE(`private_asset_id`,`category`,`normalized_value`);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_public_unique` UNIQUE(`public_asset_id`,`tag_id`);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_private_unique` UNIQUE(`private_asset_id`,`tag_id`);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD CONSTRAINT `search_index_public_asset_unique` UNIQUE(`public_asset_id`);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD CONSTRAINT `search_index_private_asset_unique` UNIQUE(`private_asset_id`);--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_task_item_id_task_items_id_fk` FOREIGN KEY (`task_item_id`) REFERENCES `task_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_task_item_segment_id_task_item_segments_id_fk` FOREIGN KEY (`task_item_segment_id`) REFERENCES `task_item_segments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_video_source_id_video_sources_id_fk` FOREIGN KEY (`video_source_id`) REFERENCES `video_sources`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_media_object_id_media_objects_id_fk` FOREIGN KEY (`media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `private_assets` ADD CONSTRAINT `private_assets_thumbnail_media_object_id_media_objects_id_fk` FOREIGN KEY (`thumbnail_media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_task_item_id_task_items_id_fk` FOREIGN KEY (`task_item_id`) REFERENCES `task_items`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_task_item_segment_id_task_item_segments_id_fk` FOREIGN KEY (`task_item_segment_id`) REFERENCES `task_item_segments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_video_source_id_video_sources_id_fk` FOREIGN KEY (`video_source_id`) REFERENCES `video_sources`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_media_object_id_media_objects_id_fk` FOREIGN KEY (`media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `public_assets` ADD CONSTRAINT `public_assets_thumbnail_media_object_id_media_objects_id_fk` FOREIGN KEY (`thumbnail_media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `private_assets_user_created_idx` ON `private_assets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `private_assets_user_processing_created_idx` ON `private_assets` (`user_id`,`processing_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_assets_uploader_review_created_idx` ON `public_assets` (`uploader_user_id`,`review_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_assets_review_created_idx` ON `public_assets` (`review_status`,`created_at`);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_target_check` CHECK (((`analysis_results`.`asset_id` is not null) + (`analysis_results`.`public_asset_id` is not null) + (`analysis_results`.`private_asset_id` is not null)) = 1);--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD CONSTRAINT `asset_tag_rejections_target_check` CHECK (((`asset_tag_rejections`.`asset_id` is not null) + (`asset_tag_rejections`.`public_asset_id` is not null) + (`asset_tag_rejections`.`private_asset_id` is not null)) = 1);--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_target_check` CHECK (((`asset_tags`.`asset_id` is not null) + (`asset_tags`.`public_asset_id` is not null) + (`asset_tags`.`private_asset_id` is not null)) = 1);--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_asset_target_check` CHECK (((`jobs`.`asset_id` is not null) + (`jobs`.`public_asset_id` is not null) + (`jobs`.`private_asset_id` is not null)) <= 1);--> statement-breakpoint
ALTER TABLE `search_index_state` ADD CONSTRAINT `search_index_target_check` CHECK (((`search_index_state`.`asset_id` is not null) + (`search_index_state`.`public_asset_id` is not null) + (`search_index_state`.`private_asset_id` is not null)) = 1);--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_results` ADD CONSTRAINT `analysis_results_private_asset_id_private_assets_id_fk` FOREIGN KEY (`private_asset_id`) REFERENCES `private_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD CONSTRAINT `asset_tag_rejections_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tag_rejections` ADD CONSTRAINT `asset_tag_rejections_private_asset_id_private_assets_id_fk` FOREIGN KEY (`private_asset_id`) REFERENCES `private_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_tags` ADD CONSTRAINT `asset_tags_private_asset_id_private_assets_id_fk` FOREIGN KEY (`private_asset_id`) REFERENCES `private_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_private_asset_id_private_assets_id_fk` FOREIGN KEY (`private_asset_id`) REFERENCES `private_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `search_index_state` ADD CONSTRAINT `search_index_state_public_asset_id_public_assets_id_fk` FOREIGN KEY (`public_asset_id`) REFERENCES `public_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `search_index_state` ADD CONSTRAINT `search_index_state_private_asset_id_private_assets_id_fk` FOREIGN KEY (`private_asset_id`) REFERENCES `private_assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_sources` ADD CONSTRAINT `video_sources_public_media_object_id_media_objects_id_fk` FOREIGN KEY (`public_media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_sources` ADD CONSTRAINT `video_sources_private_media_object_id_media_objects_id_fk` FOREIGN KEY (`private_media_object_id`) REFERENCES `media_objects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `jobs_public_asset_idx` ON `jobs` (`public_asset_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_private_asset_idx` ON `jobs` (`private_asset_id`,`status`);--> statement-breakpoint
CREATE ALGORITHM = undefined
SQL SECURITY definer
VIEW `analysis_result_entries` AS (
  select id, 'public' as kind, public_asset_id as asset_id, schema_version,
    result_json, model_protocol, model_name, completed_at
  from analysis_results where public_asset_id is not null
  union all
  select id, 'private' as kind, private_asset_id as asset_id, schema_version,
    result_json, model_protocol, model_name, completed_at
  from analysis_results where private_asset_id is not null
);--> statement-breakpoint
CREATE ALGORITHM = undefined
SQL SECURITY definer
VIEW `asset_entries` AS (
  select 'public' as kind, id, null as user_id, uploader_user_id,
    null as public_asset_id, task_id, task_item_id, task_item_segment_id,
    video_source_id, media_object_id, thumbnail_media_object_id, segment_index,
    segment_start_ms, segment_end_ms, name, description, media_type,
    original_filename, original_path, mime_type, size_bytes, processing_status,
    review_status, failure_code, failure_message, created_at, updated_at, deleted_at
  from public_assets
  union all
  select 'private' as kind, id, user_id, null as uploader_user_id,
    public_asset_id, task_id, task_item_id, task_item_segment_id,
    video_source_id, media_object_id, thumbnail_media_object_id, segment_index,
    segment_start_ms, segment_end_ms, name, description, media_type,
    original_filename, original_path, mime_type, size_bytes, processing_status,
    'published' as review_status, failure_code, failure_message,
    created_at, updated_at, deleted_at
  from private_assets
);--> statement-breakpoint
CREATE ALGORITHM = undefined
SQL SECURITY definer
VIEW `asset_tag_entries` AS (
  select id, 'public' as kind, public_asset_id as asset_id, tag_id, source, confidence
  from asset_tags where public_asset_id is not null
  union all
  select id, 'private' as kind, private_asset_id as asset_id, tag_id, source, confidence
  from asset_tags where private_asset_id is not null
);--> statement-breakpoint
CREATE ALGORITHM = undefined
SQL SECURITY definer
VIEW `asset_tag_rejection_entries` AS (
  select id, 'public' as kind, public_asset_id as asset_id, category, normalized_value
  from asset_tag_rejections where public_asset_id is not null
  union all
  select id, 'private' as kind, private_asset_id as asset_id, category, normalized_value
  from asset_tag_rejections where private_asset_id is not null
);--> statement-breakpoint
CREATE ALGORITHM = undefined
SQL SECURITY definer
VIEW `search_index_entries` AS (
  select id, 'public' as kind, public_asset_id as asset_id, status,
    content_hash, indexed_at, error_message, updated_at
  from search_index_state where public_asset_id is not null
  union all
  select id, 'private' as kind, private_asset_id as asset_id, status,
    content_hash, indexed_at, error_message, updated_at
  from search_index_state where private_asset_id is not null
);--> statement-breakpoint
CREATE OR REPLACE SQL SECURITY INVOKER VIEW `reporting_database_tables` AS
SELECT
	(
		SELECT COUNT(*)
		FROM information_schema.TABLES database_tables
		WHERE database_tables.TABLE_SCHEMA = DATABASE()
			AND database_tables.TABLE_TYPE = 'BASE TABLE'
	) AS `base_table_count`,
	catalog.`table_name`,
	catalog.`domain`,
	catalog.`description`,
	catalog.`row_count`,
	UTC_TIMESTAMP(3) AS `calculated_at`
FROM (
	SELECT '__drizzle_migrations' AS `table_name`, '系统' AS `domain`, 'Drizzle 已执行数据库迁移的内部历史。' AS `description`, (SELECT COUNT(*) FROM `__drizzle_migrations`) AS `row_count`
	UNION ALL SELECT 'analysis_results', '素材核心', '公私素材各自的模型分析结果。', (SELECT COUNT(*) FROM `analysis_results`)
	UNION ALL SELECT 'asset_tag_rejections', '素材核心', '公私素材独立拒绝的模型标签。', (SELECT COUNT(*) FROM `asset_tag_rejections`)
	UNION ALL SELECT 'asset_tags', '素材核心', '公私素材与标签的多对多关系。', (SELECT COUNT(*) FROM `asset_tags`)
	UNION ALL SELECT 'private_assets', '素材核心', '用户个人素材。', (SELECT COUNT(*) FROM `private_assets`)
	UNION ALL SELECT 'public_assets', '素材核心', '公共审核与浏览素材。', (SELECT COUNT(*) FROM `public_assets`)
	UNION ALL SELECT 'callback_deliveries', '异步任务', '任务回调的逐次 HTTP 投递记录。', (SELECT COUNT(*) FROM `callback_deliveries`)
	UNION ALL SELECT 'idempotency_requests', '一致性', 'API 幂等键与可复用任务响应。', (SELECT COUNT(*) FROM `idempotency_requests`)
	UNION ALL SELECT 'jobs', '异步任务', 'Worker 可抢占的内部作业队列。', (SELECT COUNT(*) FROM `jobs`)
	UNION ALL SELECT 'media_objects', '媒体存储', '本地或 ZOS 中的真实媒体对象。', (SELECT COUNT(*) FROM `media_objects`)
	UNION ALL SELECT 'outbox_events', '一致性', '事务内可靠事件及异步处理状态。', (SELECT COUNT(*) FROM `outbox_events`)
	UNION ALL SELECT 'search_index_state', '检索', 'MySQL 与 Chroma 向量索引的一致性水位。', (SELECT COUNT(*) FROM `search_index_state`)
	UNION ALL SELECT 'tags', '素材核心', '规范化标签字典。', (SELECT COUNT(*) FROM `tags`)
	UNION ALL SELECT 'task_item_segments', '媒体存储', '父视频分镜服务返回的逻辑切片清单。', (SELECT COUNT(*) FROM `task_item_segments`)
	UNION ALL SELECT 'task_items', '异步任务', '上传任务中的单个原始文件。', (SELECT COUNT(*) FROM `task_items`)
	UNION ALL SELECT 'tasks', '异步任务', '所有对外异步操作共享的任务主表。', (SELECT COUNT(*) FROM `tasks`)
	UNION ALL SELECT 'users', '用户', '应用观察到的用户作用域及预留资料。', (SELECT COUNT(*) FROM `users`)
	UNION ALL SELECT 'video_sources', '媒体存储', '上传的完整父视频及公私对象引用。', (SELECT COUNT(*) FROM `video_sources`)
) catalog;--> statement-breakpoint
CREATE OR REPLACE SQL SECURITY INVOKER VIEW `reporting_user_assets` AS
WITH
task_stats AS (
	SELECT
		`user_id`,
		COUNT(*) AS `task_count`,
		SUM(`status` = 'done') AS `done_task_count`,
		SUM(`status` = 'failed') AS `failed_task_count`
	FROM `tasks`
	WHERE `user_id` IS NOT NULL
	GROUP BY BINARY `user_id`, `user_id`
),
asset_stats AS (
	SELECT
		asset.`user_id`,
		COUNT(*) AS `total_asset_records`,
		SUM(asset.`deleted_at` IS NULL) AS `active_asset_count`,
		SUM(asset.`deleted_at` IS NOT NULL) AS `deleted_asset_count`,
		SUM(asset.`deleted_at` IS NULL AND asset.`media_type` = 'image') AS `image_asset_count`,
		SUM(asset.`deleted_at` IS NULL AND asset.`media_type` = 'video') AS `video_slice_count`,
		COUNT(DISTINCT CASE WHEN asset.`deleted_at` IS NULL THEN asset.`video_source_id` END) AS `parent_video_count`,
		SUM(
			CASE WHEN asset.`deleted_at` IS NULL THEN
				COALESCE(main_media.`size_bytes`, 0) +
				CASE WHEN asset.`media_type` = 'video' THEN COALESCE(thumbnail_media.`size_bytes`, 0) ELSE 0 END
			ELSE 0 END
		) AS `total_storage_bytes`
	FROM `private_assets` asset
	LEFT JOIN `media_objects` main_media
		ON main_media.`id` = asset.`media_object_id`
		AND main_media.`status` = 'persisted'
	LEFT JOIN `media_objects` thumbnail_media
		ON thumbnail_media.`id` = asset.`thumbnail_media_object_id`
		AND thumbnail_media.`status` = 'persisted'
	GROUP BY BINARY asset.`user_id`, asset.`user_id`
),
parent_stats AS (
	SELECT
		source.`id` AS `video_source_id`,
		COUNT(asset.`id`) AS `current_asset_segment_count`,
		SUM(asset.`deleted_at` IS NULL) AS `active_asset_segment_count`
	FROM `video_sources` source
	LEFT JOIN `private_assets` asset ON asset.`video_source_id` = source.`id`
	GROUP BY source.`id`
),
tag_stats AS (
	SELECT
		relation.`private_asset_id` AS `asset_id`,
		COUNT(*) AS `tag_count`,
		GROUP_CONCAT(
			CONCAT(tag.`category`, ':', tag.`value`)
			ORDER BY tag.`category`, tag.`value`
			SEPARATOR ', '
		) AS `tags`
	FROM `asset_tags` relation
	INNER JOIN `tags` tag ON tag.`id` = relation.`tag_id`
	WHERE relation.`private_asset_id` IS NOT NULL
	GROUP BY relation.`private_asset_id`
)
SELECT
	user_record.`user_id`,
	user_record.`display_name`,
	user_record.`email`,
	user_record.`department`,
	user_record.`first_seen_at`,
	user_record.`last_seen_at`,
	COALESCE(task_summary.`task_count`, 0) AS `task_count`,
	COALESCE(task_summary.`done_task_count`, 0) AS `done_task_count`,
	COALESCE(task_summary.`failed_task_count`, 0) AS `failed_task_count`,
	COALESCE(asset_summary.`total_asset_records`, 0) AS `total_asset_records`,
	COALESCE(asset_summary.`active_asset_count`, 0) AS `active_asset_count`,
	COALESCE(asset_summary.`deleted_asset_count`, 0) AS `deleted_asset_count`,
	COALESCE(asset_summary.`image_asset_count`, 0) AS `image_asset_count`,
	COALESCE(asset_summary.`video_slice_count`, 0) AS `video_slice_count`,
	COALESCE(asset_summary.`parent_video_count`, 0) AS `parent_video_count`,
	COALESCE(asset_summary.`total_storage_bytes`, 0) AS `total_storage_bytes`,
	asset.`id` AS `asset_id`,
	asset.`name` AS `asset_name`,
	asset.`description` AS `asset_description`,
	asset.`media_type`,
	asset.`processing_status`,
	'published' AS `review_status`,
	asset.`original_filename`,
	asset.`mime_type`,
	asset.`size_bytes` AS `asset_size_bytes`,
	COALESCE(main_media.`size_bytes`, 0) AS `stored_media_bytes`,
	CASE WHEN asset.`media_type` = 'video' THEN COALESCE(thumbnail_media.`size_bytes`, 0) ELSE 0 END AS `thumbnail_bytes`,
	asset.`created_at` AS `asset_created_at`,
	asset.`updated_at` AS `asset_updated_at`,
	asset.`deleted_at` AS `asset_deleted_at`,
	COALESCE(tag_summary.`tag_count`, 0) AS `tag_count`,
	tag_summary.`tags`,
	source.`id` AS `parent_video_id`,
	source.`original_filename` AS `parent_video_filename`,
	source.`duration_ms` AS `parent_video_duration_ms`,
	source.`size_bytes` AS `parent_video_size_bytes`,
	source.`status` AS `parent_video_status`,
	source.`generated_segment_count`,
	COALESCE(parent_summary.`current_asset_segment_count`, 0) AS `current_asset_segment_count`,
	COALESCE(parent_summary.`active_asset_segment_count`, 0) AS `active_asset_segment_count`
FROM `users` user_record
LEFT JOIN `private_assets` asset ON BINARY asset.`user_id` = BINARY user_record.`user_id`
LEFT JOIN task_stats task_summary ON BINARY task_summary.`user_id` = BINARY user_record.`user_id`
LEFT JOIN asset_stats asset_summary ON BINARY asset_summary.`user_id` = BINARY user_record.`user_id`
LEFT JOIN `media_objects` main_media
	ON main_media.`id` = asset.`media_object_id`
	AND main_media.`status` = 'persisted'
LEFT JOIN `media_objects` thumbnail_media
	ON thumbnail_media.`id` = asset.`thumbnail_media_object_id`
	AND thumbnail_media.`status` = 'persisted'
LEFT JOIN tag_stats tag_summary ON tag_summary.`asset_id` = asset.`id`
LEFT JOIN `video_sources` source ON source.`id` = asset.`video_source_id`
LEFT JOIN parent_stats parent_summary ON parent_summary.`video_source_id` = source.`id`;
