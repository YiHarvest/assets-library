import { describe, expect, it } from "vitest";
import { compareLegacyDocuments } from "@/server/search/v2/rollback";

describe("legacy rollback content verification", () => {
  it("checks exact text multisets, duplicate chunks, stale updates and deleted leftovers", () => {
    const expected = [{ assetId: "a", contents: ["first", "second"] }, { assetId: "deleted", contents: [] }];
    const documents = [{ assetId: "a", content: "second" }, { assetId: "a", content: "first" }];
    expect(compareLegacyDocuments(expected, documents).matched).toBe(true);
    expect(compareLegacyDocuments(expected, [...documents, documents[0]]).matched).toBe(false);
    expect(compareLegacyDocuments(expected, [{ assetId: "a", content: "stale" }]).mismatchedAssets).toBe(1);
    expect(compareLegacyDocuments(expected, [...documents, { assetId: "deleted", content: "old" }]).mismatchedAssets).toBe(1);
    expect(compareLegacyDocuments(expected, [...documents, { assetId: "unknown", content: "old" }]).unexpectedAssets).toBe(1);
  });
});
