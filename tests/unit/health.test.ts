import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectHealth } from "@/server/health/service";
import {
  readWorkerHeartbeat,
  removeWorkerHeartbeat,
  writeWorkerHeartbeat,
} from "@/server/health/worker-heartbeat";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function healthyDependencies() {
  return {
    now: () => new Date("2026-08-12T02:17:00.000Z"),
    worker: async () => ({
      status: "up" as const,
      last_heartbeat_at: "2026-08-12T10:16:59.000+08:00",
    }),
    mysql: async () => ({ status: "up" as const }),
    chroma: async () => ({ status: "up" as const }),
    sceneDetect: async () => ({ status: "up" as const }),
    zos: async () => ({ status: "up" as const }),
  };
}

describe("application health", () => {
  it("returns an aggregate healthy report using Shanghai API time", async () => {
    const report = await collectHealth(healthyDependencies());

    expect(report).toEqual({
      status: "ok",
      checked_at: "2026-08-12T10:17:00.000+08:00",
      services: {
        web: { status: "up" },
        worker: {
          status: "up",
          last_heartbeat_at: "2026-08-12T10:16:59.000+08:00",
        },
        mysql: { status: "up" },
        chroma: { status: "up" },
        scene_detect: { status: "up" },
        zos: { status: "up" },
      },
    });
  });

  it("marks the aggregate unavailable without exposing dependency errors", async () => {
    const report = await collectHealth({
      ...healthyDependencies(),
      mysql: async () => {
        throw new Error(
          "mysql://secret-user:secret-password@private-host/internal-db",
        );
      },
      sceneDetect: async () => ({ status: "disabled" }),
    });

    expect(report.status).toBe("unavailable");
    expect(report.services.mysql).toEqual({ status: "down" });
    expect(report.services.scene_detect).toEqual({ status: "disabled" });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("private-host");
  });

  it("atomically writes, reads and owner-safely removes worker heartbeat", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "health-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "worker.heartbeat.json");
    const now = new Date("2026-08-12T02:17:00.000Z");

    await writeWorkerHeartbeat(filePath, now, 12_345);
    await expect(readWorkerHeartbeat(filePath)).resolves.toEqual({
      pid: 12_345,
      updatedAt: now,
    });

    await removeWorkerHeartbeat(filePath, 54_321);
    await expect(readWorkerHeartbeat(filePath)).resolves.not.toBeNull();
    await removeWorkerHeartbeat(filePath, 12_345);
    await expect(readWorkerHeartbeat(filePath)).resolves.toBeNull();
  });
});
