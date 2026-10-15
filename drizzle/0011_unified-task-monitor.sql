CREATE TABLE `call_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`span_id` varchar(36) NOT NULL,
	`level` enum('info','warn','error') NOT NULL DEFAULT 'info',
	`message` text NOT NULL,
	`data` json,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `call_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `call_spans` (
	`id` varchar(36) NOT NULL,
	`trace_id` varchar(36) NOT NULL,
	`parent_span_id` varchar(36),
	`task_id` varchar(36),
	`kind` enum('api','function','match') NOT NULL,
	`name` varchar(512) NOT NULL,
	`status` enum('running','done','failed') NOT NULL DEFAULT 'running',
	`input` json,
	`output` json,
	`error` json,
	`status_code` int unsigned,
	`duration_ms` double,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `call_spans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`level` enum('info','warn','error') NOT NULL DEFAULT 'info',
	`phase` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`data` json,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `task_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `input` json;--> statement-breakpoint
ALTER TABLE `tasks` ADD `trace_id` varchar(36);--> statement-breakpoint
ALTER TABLE `tasks` ADD `origin_span_id` varchar(36);--> statement-breakpoint
ALTER TABLE `call_logs` ADD CONSTRAINT `call_logs_span_id_call_spans_id_fk` FOREIGN KEY (`span_id`) REFERENCES `call_spans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_logs` ADD CONSTRAINT `task_logs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `call_logs_span_idx` ON `call_logs` (`span_id`,`id`);--> statement-breakpoint
CREATE INDEX `call_spans_started_idx` ON `call_spans` (`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `call_spans_trace_idx` ON `call_spans` (`trace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `call_spans_task_idx` ON `call_spans` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `call_spans_expires_idx` ON `call_spans` (`expires_at`);--> statement-breakpoint
CREATE INDEX `task_logs_task_id_idx` ON `task_logs` (`task_id`,`id`);