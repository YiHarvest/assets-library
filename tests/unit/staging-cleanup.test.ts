import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredAnalysisWorkspaces,
  cleanupExpiredStaging,
  stagingRetentionMs,
} from "@/server/services/staging-cleanup";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("staging cleanup", () => {
  it("只清理超过 24 小时的任务目录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assets-staging-"));
    temporaryRoots.push(root);
    const expired = path.join(root, "expired-task");
    const recent = path.join(root, "recent-task");
    await fs.mkdir(expired);
    await fs.mkdir(recent);
    const now = Date.now();
    const expiredTime = new Date(now - stagingRetentionMs - 1_000);
    await fs.utimes(expired, expiredTime, expiredTime);

    expect(await cleanupExpiredStaging(now, root, stagingRetentionMs)).toBe(1);
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recent)).resolves.toBeDefined();
  });

  it("staging 根目录尚未创建时返回零", async () => {
    const root = path.join(os.tmpdir(), crypto.randomUUID(), "missing");
    expect(
      await cleanupExpiredStaging(Date.now(), root, stagingRetentionMs),
    ).toBe(0);
  });

  it("清理过期的分析关键帧工作区并保留近期目录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assets-analysis-"));
    temporaryRoots.push(root);
    const expired = path.join(root, "expired-job");
    const recent = path.join(root, "recent-job");
    await fs.mkdir(expired);
    await fs.mkdir(recent);
    const now = Date.now();
    const expiredTime = new Date(now - stagingRetentionMs - 1_000);
    await fs.utimes(expired, expiredTime, expiredTime);

    expect(
      await cleanupExpiredAnalysisWorkspaces(now, root, stagingRetentionMs),
    ).toBe(1);
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recent)).resolves.toBeDefined();
  });
});
