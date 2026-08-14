import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const migrations = path.resolve(import.meta.dirname, "../drizzle");

test("media object unique index stays below the MySQL utf8mb4 key limit", () => {
  const initial = readFileSync(
    path.join(migrations, "0000_careful_spyke.sql"),
    "utf8",
  );

  assert.match(initial, /`bucket` varchar\(63\) NOT NULL/);
  assert.match(initial, /`object_key` varchar\(512\) NOT NULL/);
  assert.ok((63 + 512) * 4 < 3072);
});

test("video source replacement index is created before the FK index is dropped", () => {
  const migration = readFileSync(
    path.join(migrations, "0003_narrow_black_panther.sql"),
    "utf8",
  );
  const createAt = migration.indexOf("CREATE INDEX `task_files_video_source_idx`");
  const dropAt = migration.indexOf("DROP INDEX `task_files_video_source_unique`");

  assert.ok(createAt >= 0);
  assert.ok(dropAt > createAt);
});

test("validate jobs may carry a stable file id before the asset row exists", () => {
  const migration = readFileSync(
    path.join(migrations, "0004_aromatic_timeslip.sql"),
    "utf8",
  );

  assert.match(
    migration,
    /DROP FOREIGN KEY `jobs_file_id_assets_id_fk`/,
  );
});

test("video segment orchestration has a finalize type and durable dedupe key", () => {
  const migration = readFileSync(
    path.join(migrations, "0005_mysterious_dragon_lord.sql"),
    "utf8",
  );
  assert.match(migration, /'analyze','finalize','embed'/);
  assert.match(migration, /ADD `dedupe_key` varchar\(191\)/);
  assert.match(migration, /jobs_dedupe_key_unique/);
});

test("segment analysis jobs are migrated to the explicit analyze_segment type", () => {
  const migration = readFileSync(
    path.join(migrations, "0006_careful_dreaming_celestial.sql"),
    "utf8",
  );
  assert.match(migration, /'split','analyze_segment','finalize','embed'/);
  assert.doesNotMatch(migration, /'split','analyze','finalize'/);
});
