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
    ).toContain("assets.review_status");
  });
});
