import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  expectedDatabaseColumns,
  missingDatabaseColumns,
} from "@/server/db/migrations";

describe("database migration schema guard", () => {
  it("accepts a database containing every Drizzle table column", () => {
    const actual = expectedDatabaseColumns.map((entry) => {
      const separator = entry.indexOf(".");
      return {
        TABLE_NAME: entry.slice(0, separator),
        COLUMN_NAME: entry.slice(separator + 1),
      };
    });

    expect(missingDatabaseColumns(actual)).toEqual([]);
  });

  it("reports the exact missing table column", () => {
    expect(
      missingDatabaseColumns([
        { TABLE_NAME: "assets", COLUMN_NAME: "id" },
      ]),
    ).toContain("public_assets.review_status");
    expect(expectedDatabaseColumns.some((entry) => entry.startsWith("assets."))).toBe(
      false,
    );
  });

  it("keeps legacy links until the startup data migration has completed", async () => {
    const migration = await fs.readFile(
      "drizzle/0007_remove_legacy_asset_links.sql",
      "utf8",
    );

    expect(migration).not.toMatch(/DELETE FROM `(?:analysis_results|asset_tags)`/);
    expect(migration).not.toMatch(/DROP COLUMN `(?:asset_id|media_object_id)`/);
  });
});
