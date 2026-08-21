import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStagingPath } from "@/server/modules/uploads/upload-service";

describe("upload staging path containment", () => {
  it("accepts a contained path when mediaRoot has a trailing separator", () => {
    const root = path.join(path.sep, "tmp", "assets-media") + path.sep;
    expect(resolveStagingPath(root, ".staging/task/item.mp4")).toBe(
      path.join(root, ".staging", "task", "item.mp4"),
    );
  });

  it("rejects paths that escape or resolve to mediaRoot", () => {
    const root = path.join(path.sep, "tmp", "assets-media");
    expect(() => resolveStagingPath(root, "../outside.mp4")).toThrow(
      "上传暂存路径无效",
    );
    expect(() => resolveStagingPath(root, ".")).toThrow("上传暂存路径无效");
  });
});
