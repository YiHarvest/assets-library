import { describe, expect, it, vi } from "vitest";
import {
  TaskService,
  type TaskRepository,
} from "@/server/modules/tasks/task-service";

function taskRow(id: string, userId = "user-001") {
  const now = new Date("2026-08-21T00:00:00.000Z");
  return {
    task: {
      id,
      userId,
      type: "upload",
      status: "done",
      phase: "finished",
      progressPercent: 100,
      receivedBytes: 3,
      totalBytes: 3,
      totalItems: 0,
      doneItems: 0,
      failedItems: 0,
      callbackUrl: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      expiresAt: null,
    },
    items: [],
  };
}

describe("TaskService.listTasks", () => {
  it("returns full user-scoped task snapshots and an opaque next cursor", async () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const listUserTaskIds = vi.fn(async () => [
      { id: first, createdAt: new Date("2026-08-21T00:00:00.000Z") },
      { id: second, createdAt: new Date("2026-08-20T00:00:00.000Z") },
    ]);
    const repository = {
      listUserTaskIds,
      getTaskWithItems: vi.fn(async (id: string) => taskRow(id)),
      listTaskItemAssetIds: vi.fn(async () => []),
    } satisfies TaskRepository;
    const service = new TaskService(repository);

    const result = await service.listTasks("user-001", {
      limit: 1,
      statuses: ["done"],
      types: ["upload"],
    });

    expect(result.items.map((item) => item.task_id)).toEqual([first]);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(listUserTaskIds).toHaveBeenCalledWith("user-001", {
      statuses: ["done"],
      types: ["upload"],
      before: undefined,
      limit: 2,
    });
  });

  it("rejects malformed cursors before querying the repository", async () => {
    const listUserTaskIds = vi.fn(async () => []);
    const repository = {
      listUserTaskIds,
      getTaskWithItems: vi.fn(),
      listTaskItemAssetIds: vi.fn(async () => []),
    } as unknown as TaskRepository;
    const service = new TaskService(repository);

    await expect(
      service.listTasks("user-001", { limit: 10, cursor: "not-json" }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(listUserTaskIds).not.toHaveBeenCalled();
  });
});
