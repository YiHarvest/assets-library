import { describe, expect, it, vi } from "vitest";
import { resolveRecallManifest } from "@/server/search/v2/facade";
import { searchIndexDefinition } from "@/server/search/v2/manifest";
import { manifest } from "../helpers/recall";

const build = { ...manifest, physicalIndex: "asset_library_dev_recall_v2_000001" };
const metadata = { ...searchIndexDefinition(build), aliases: { asset_library_dev_recall_read: {} } };

describe("recall build pinning", () => {
  it("accepts exactly one unfiltered physical index in the configured environment", async () => {
    const request = vi.fn(async () => Response.json({ [build.physicalIndex]: metadata }));
    expect(await resolveRecallManifest(request, "asset_library_dev")).toEqual(build);
    expect(request).toHaveBeenCalledExactlyOnceWith("/asset_library_dev_recall_read?features=aliases,mappings");
    request.mockResolvedValueOnce(Response.json({
      asset_library_dev_recall_v2_000001: { aliases: { asset_library_dev_recall_read: {} } },
      asset_library_dev_recall_v2_000002: { aliases: { asset_library_dev_recall_read: {} } },
    }));
    await expect(resolveRecallManifest(request, "asset_library_dev")).rejects.toThrow(/唯一/);
    request.mockResolvedValueOnce(Response.json({ asset_library_prd_recall_v2_000001: { aliases: { asset_library_dev_recall_read: {} } } }));
    await expect(resolveRecallManifest(request, "asset_library_dev")).rejects.toThrow(/环境/);
    request.mockResolvedValueOnce(Response.json({ asset_library_dev_recall_v2_000001: { aliases: { asset_library_dev_recall_read: { filter: { term: { assetId: "one" } } } } } }));
    await expect(resolveRecallManifest(request, "asset_library_dev")).rejects.toThrow(/过滤/);
  });
  it("rejects routed aliases and a manifest belonging to a different physical index", async () => {
    const request = vi.fn(async () => Response.json({}));
    for (const routing of ["routing", "search_routing", "index_routing"]) {
      request.mockResolvedValueOnce(Response.json({ [build.physicalIndex]: { ...metadata,
        aliases: { asset_library_dev_recall_read: { [routing]: "one" } } } }));
      await expect(resolveRecallManifest(request, "asset_library_dev")).rejects.toThrow(/路由/);
    }
    request.mockResolvedValueOnce(Response.json({ [build.physicalIndex]: { ...metadata,
      mappings: searchIndexDefinition({ ...build, physicalIndex: "asset_library_dev_recall_v2_000002" }).mappings } }));
    await expect(resolveRecallManifest(request, "asset_library_dev")).rejects.toThrow(/清单/);
  });
});
