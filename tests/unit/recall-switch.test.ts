import { describe, expect, it, vi } from "vitest";
import { switchRecallAlias } from "@/server/search/v2/switch";

describe("atomic recall alias switch", () => {
  it("removes only the expected binding, adds exactly one target, and verifies the result", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ old_recall_v2_1: { aliases: { old_recall_read: {} } } }))
      .mockResolvedValueOnce(Response.json({ acknowledged: true }))
      .mockResolvedValueOnce(Response.json({ old_recall_v2_2: { aliases: { old_recall_read: {} } } }));
    await switchRecallAlias(request, "old", "old_recall_v2_1", "old_recall_v2_2");
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ actions: [
      { remove: { index: "old_recall_v2_1", alias: "old_recall_read", must_exist: true } },
      { add: { index: "old_recall_v2_2", alias: "old_recall_read", is_write_index: false } },
    ] });
  });
  it("rejects a moved or filtered alias and never silently switches another environment", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ old_recall_v2_other: { aliases: { old_recall_read: {} } } }));
    await expect(switchRecallAlias(request, "old", "old_recall_v2_1", "old_recall_v2_2")).rejects.toThrow(/changed/);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(switchRecallAlias(request, "old", null, "prd_recall_v2_2")).rejects.toThrow(/environment/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
