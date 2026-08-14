ALTER TABLE `jobs` MODIFY COLUMN `type` enum('validate','transcode','split','analyze_segment','finalize','embed','publish','update','retry','delete','callback','cleanup') NOT NULL;
