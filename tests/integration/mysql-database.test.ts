import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeDatabase,
  inspectDatabaseConnection,
  type DatabaseConnection,
} from "@/server/db/connection";
import { initializeDatabase } from "@/server/db/migrations";
import {
  assets,
  jobs,
  mediaObjects,
  taskItems,
  tasks,
  users,
  videoSources,
} from "@/server/db/schema";
import type { ObjectStorage } from "@/server/storage/object-storage";

const searchAnalysisMock = vi.hoisted(() => vi.fn());
const deleteAnalysisMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/server/search/chroma", () => ({
  searchAnalysis: searchAnalysisMock,
  deleteAnalysis: deleteAnalysisMock,
  semanticSearchEnabled: () => true,
}));

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mysqlTest = testDatabaseUrl ? describe : describe.skip;

const applicationTables = [
  "analysis_results",
  "asset_tag_rejections",
  "asset_tags",
  "assets",
  "callback_deliveries",
  "idempotency_requests",
  "jobs",
  "media_objects",
  "outbox_events",
  "search_index_state",
  "tags",
  "task_item_segments",
  "task_items",
  "tasks",
  "users",
  "video_sources",
] as const;

type Repository = typeof import("@/server/repositories/assets");

function assertDedicatedTestDatabase(url: string) {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL 必须指向以 _test 结尾的独立测试库。");
  }
}

/** 仅清空专用测试库中的业务表，绝不删除数据库或生产 schema。 */
async function truncateApplicationTables(pool: Pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of applicationTables) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    connection.release();
  }
}

mysqlTest("MySQL 数据层", () => {
  let migrationConnection: DatabaseConnection;
  let repositoryPool: Pool;
  let repository: Repository;
  let lifecycle: typeof import("@/server/services/task-lifecycle");

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    assertDedicatedTestDatabase(testDatabaseUrl);
    process.env.DATABASE_URL = testDatabaseUrl;
    migrationConnection = await initializeDatabase({
      url: testDatabaseUrl,
      sslCaPath: process.env.DATABASE_SSL_CA_PATH || undefined,
      poolSize: 4,
    });
    repository = await import("@/server/repositories/assets");
    ({ pool: repositoryPool } = await import("@/server/db"));
    lifecycle = await import("@/server/services/task-lifecycle");
  }, 30_000);

  beforeEach(async () => {
    await truncateApplicationTables(migrationConnection.pool);
  });

  afterAll(async () => {
    if (repositoryPool) await repositoryPool.end();
    if (migrationConnection) await closeDatabase(migrationConnection);
  });

  async function insertSchedulingTask(id: string, createdAt: Date) {
    await migrationConnection.db.insert(tasks).values({
      id,
      type: "upload",
      status: "running",
      phase: "analyzing",
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function insertSchedulingJob(input: {
    taskId: string;
    type: "validate" | "analyze";
    createdAt: Date;
  }) {
    const id = crypto.randomUUID();
    await migrationConnection.db.insert(jobs).values({
      id,
      taskId: input.taskId,
      type: input.type,
      availableAt: input.createdAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return id;
  }

  test("validate 作业优先于更早入队的 analyze 作业", async () => {
    const now = new Date();
    const analysisTaskId = crypto.randomUUID();
    const validationTaskId = crypto.randomUUID();
    await insertSchedulingTask(analysisTaskId, new Date(now.getTime() - 2_000));
    await insertSchedulingTask(validationTaskId, new Date(now.getTime() - 1_000));
    await insertSchedulingJob({
      taskId: analysisTaskId,
      type: "analyze",
      createdAt: new Date(now.getTime() - 2_000),
    });
    const validationJobId = await insertSchedulingJob({
      taskId: validationTaskId,
      type: "validate",
      createdAt: new Date(now.getTime() - 1_000),
    });

    await expect(repository.claimNextJob("priority-test")).resolves.toMatchObject({
      id: validationJobId,
      taskId: validationTaskId,
      type: "validate",
    });
  });

  test("并发领取时每个竞争任务最多占用两个分析 worker，独占队列后可突发", async () => {
    const now = new Date();
    const firstTaskId = crypto.randomUUID();
    const secondTaskId = crypto.randomUUID();
    await insertSchedulingTask(firstTaskId, new Date(now.getTime() - 2_000));
    await insertSchedulingTask(secondTaskId, new Date(now.getTime() - 1_000));
    for (let index = 0; index < 3; index += 1) {
      await insertSchedulingJob({
        taskId: firstTaskId,
        type: "analyze",
        createdAt: new Date(now.getTime() - 2_000 + index),
      });
      await insertSchedulingJob({
        taskId: secondTaskId,
        type: "analyze",
        createdAt: new Date(now.getTime() - 1_000 + index),
      });
    }

    const claimed = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        repository.claimNextJob(`fairness-test:${index}`, {
          analyzeTaskSoftLimit: 2,
        }),
      ),
    );
    const counts = new Map<string, number>();
    for (const job of claimed) {
      expect(job?.type).toBe("analyze");
      if (job?.taskId) counts.set(job.taskId, (counts.get(job.taskId) ?? 0) + 1);
    }
    expect(counts.get(firstTaskId)).toBe(2);
    expect(counts.get(secondTaskId)).toBe(2);
    await expect(
      repository.claimNextJob("fairness-test:blocked", {
        analyzeTaskSoftLimit: 2,
      }),
    ).resolves.toBeNull();

    await migrationConnection.db
      .update(jobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(jobs.taskId, secondTaskId), eq(jobs.status, "queued")));
    await expect(
      repository.claimNextJob("fairness-test:burst", {
        analyzeTaskSoftLimit: 2,
      }),
    ).resolves.toMatchObject({ taskId: firstTaskId, type: "analyze" });
  });

  test("不可分析的 retry 素材会终止任务而不是永久停留在 running", async () => {
    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      name: "unavailable retry target",
      originalFilename: "retry.jpg",
      originalPath: "/tmp/retry.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });
    await migrationConnection.db
      .update(assets)
      .set({ processingStatus: "failed", reviewStatus: "published" })
      .where(eq(assets.id, assetId));
    const created = await repository.createMutationTask({
      type: "retry",
      assetId,
      payload: { userId: null },
    });
    const retryJob = await repository.claimNextJob("retry-unavailable");
    if (!retryJob) throw new Error("retry 作业未被领取。");
    const { processMutationJob } = await import(
      "@/server/services/mutation-pipeline"
    );
    await processMutationJob(retryJob, {} as ObjectStorage);

    const analysisJob = await repository.claimNextJob("retry-analysis");
    if (!analysisJob) throw new Error("analysis 作业未被领取。");
    const analyze = vi.fn();
    const { processJob } = await import("@/server/services/processing");
    await processJob(
      analysisJob,
      { analyze },
      async () => {
        throw new Error("不可分析的素材不应进入媒体准备。");
      },
    );

    expect(analyze).not.toHaveBeenCalled();
    const [storedJob] = await migrationConnection.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, analysisJob.id));
    const [storedTask] = await migrationConnection.db
      .select({ status: tasks.status, phase: tasks.phase })
      .from(tasks)
      .where(eq(tasks.id, created.task.id));
    expect(storedJob?.status).toBe("failed");
    expect(storedTask).toEqual({ status: "failed", phase: "finished" });
  });

  test("丢失租约的旧 analysis worker 不会覆盖新 attempt 的任务状态", async () => {
    const taskId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    await insertSchedulingTask(taskId, new Date());
    await repository.createAsset({
      assetId,
      taskId,
      name: "lease handoff target",
      originalFilename: "handoff.jpg",
      originalPath: "/tmp/handoff.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });
    const jobId = await insertSchedulingJob({
      taskId,
      type: "analyze",
      createdAt: new Date(),
    });
    await migrationConnection.db
      .update(jobs)
      .set({ assetId })
      .where(eq(jobs.id, jobId));
    const staleJob = await repository.claimNextJob("old-worker");
    if (!staleJob) throw new Error("旧 worker 未领取作业。");
    await migrationConnection.db
      .update(jobs)
      .set({ status: "queued", claimedAt: null, leaseOwner: null })
      .where(eq(jobs.id, jobId));
    const currentJob = await repository.claimNextJob("new-worker");
    expect(currentJob).toMatchObject({ id: jobId, attempt: 2 });

    const analyze = vi.fn();
    const { processJob } = await import("@/server/services/processing");
    await processJob(
      staleJob,
      { analyze },
      async () => {
        throw new Error("丢失租约后不应继续处理媒体。");
      },
    );

    expect(analyze).not.toHaveBeenCalled();
    const [storedJob] = await migrationConnection.db
      .select({ status: jobs.status, attempt: jobs.attempt })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    const [storedTask] = await migrationConnection.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(storedJob).toEqual({ status: "running", attempt: 2 });
    expect(storedTask?.status).toBe("running");
  });

  test("分析调度与 mutation worker 并发时不会因 task 索引锁顺序死锁", async () => {
    const now = new Date();
    for (let taskIndex = 0; taskIndex < 4; taskIndex += 1) {
      const taskId = crypto.randomUUID();
      await insertSchedulingTask(taskId, new Date(now.getTime() + taskIndex));
      for (let jobIndex = 0; jobIndex < 3; jobIndex += 1) {
        await insertSchedulingJob({
          taskId,
          type: "analyze",
          createdAt: new Date(now.getTime() + taskIndex * 10 + jobIndex),
        });
      }
    }

    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      name: "concurrent mutation target",
      originalFilename: "target.jpg",
      originalPath: "/tmp/target.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });
    const mutationTaskIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const created = await repository.createMutationTask({
        type: "update",
        assetId,
        payload: {
          name: `updated-${index}`,
          description: "concurrency regression",
          tags: [],
          userId: null,
        },
      });
      mutationTaskIds.push(created.task.id);
    }

    const { processMutationJob } = await import(
      "@/server/services/mutation-pipeline"
    );
    const storage = {} as ObjectStorage;
    await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const leaseOwner = `mutation-deadlock:${index}`;
        for (;;) {
          const job = await repository.claimNextJob(leaseOwner, {
            analyzeTaskSoftLimit: 2,
          });
          if (!job) return;
          if (job.type === "update") await processMutationJob(job, storage);
          else await repository.completeJob(job);
        }
      }),
    );

    const mutationTasks = await migrationConnection.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, mutationTaskIds));
    expect(mutationTasks).toHaveLength(mutationTaskIds.length);
    expect(mutationTasks.every((task) => task.status === "done")).toBe(true);
  }, 30_000);

  test("迁移生成完整的 MySQL 8 schema，并以 UTC/TLS 建立连接", async () => {
    const [tableRows] = await migrationConnection.pool.query<
      Array<RowDataPacket & { tableName: string }>
    >(
      `SELECT table_name AS tableName
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
          AND table_name <> '__drizzle_migrations'
        ORDER BY table_name`,
    );
    expect(tableRows.map((row) => row.tableName)).toEqual(applicationTables);

    const [viewRows] = await migrationConnection.pool.query<
      Array<RowDataPacket & { tableName: string }>
    >(
      `SELECT table_name AS tableName
         FROM information_schema.views
        WHERE table_schema = DATABASE()
          AND table_name IN ('reporting_database_tables', 'reporting_user_assets')
        ORDER BY table_name`,
    );
    expect(viewRows.map((row) => row.tableName)).toEqual([
      "reporting_database_tables",
      "reporting_user_assets",
    ]);

    const inspection = await inspectDatabaseConnection(migrationConnection.pool);
    const [clockRows] = await migrationConnection.pool.query<
      Array<RowDataPacket & { utcDeltaSeconds: number }>
    >(
      "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS utcDeltaSeconds",
    );
    expect(Math.abs(Number(clockRows[0]?.utcDeltaSeconds ?? 60))).toBeLessThanOrEqual(1);
    expect(inspection.sslCipher).toBeTruthy();
  });

  test("注册用户列表保留零素材用户并忽略已删除素材", async () => {
    const now = new Date("2026-08-20T01:02:03.000Z");
    await migrationConnection.db.insert(users).values([
      {
        userId: "user-a",
        displayName: "用户 A",
        email: "user-a@example.com",
        department: "剪辑",
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: "user-empty",
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await migrationConnection.db.insert(assets).values([
      {
        id: crypto.randomUUID(),
        userId: "user-a",
        name: "active",
        description: "",
        mediaType: "image",
        originalFilename: "active.jpg",
        originalPath: "/tmp/active.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        reviewStatus: "published",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        userId: "user-a",
        name: "deleted",
        description: "",
        mediaType: "image",
        originalFilename: "deleted.jpg",
        originalPath: "/tmp/deleted.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        reviewStatus: "deleted",
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const registered = await repository.listRegisteredUsers();
    expect(registered).toEqual([
      expect.objectContaining({
        userId: "user-a",
        displayName: "用户 A",
        email: "user-a@example.com",
        department: "剪辑",
        assetCount: 1,
      }),
      expect.objectContaining({ userId: "user-empty", assetCount: 0 }),
    ]);

    const { DefaultApiV1Service } = await import(
      "@/server/api/v1/default-service"
    );
    await expect(new DefaultApiV1Service().listUsers()).resolves.toEqual([
      expect.objectContaining({
        user_id: "user-a",
        display_name: "用户 A",
        first_seen_at: "2026-08-20T09:02:03.000+08:00",
        asset_count: 1,
      }),
      expect.objectContaining({ user_id: "user-empty", asset_count: 0 }),
    ]);
  });

  test("流式上传进度在封存前不会误报完成，封存后创建校验作业", async () => {
    const taskId = crypto.randomUUID();
    const firstItemId = crypto.randomUUID();
    const secondItemId = crypto.randomUUID();
    await repository.createTaskWithItems({
      id: taskId,
      type: "upload",
      userId: "user-a",
      result: { auto_publish: true },
      items: [
        {
          id: firstItemId,
          ordinal: 0,
          filename: "first.jpg",
          totalBytes: 5,
          stagingPath: "/tmp/first.jpg",
        },
        {
          id: secondItemId,
          ordinal: 1,
          filename: "second.mp4",
          totalBytes: 15,
          stagingPath: "/tmp/second.mp4",
        },
      ],
    });

    const [registeredUser] = await migrationConnection.db
      .select()
      .from(users)
      .where(eq(users.userId, "user-a"));
    expect(registeredUser).toMatchObject({
      userId: "user-a",
      displayName: null,
      email: null,
      department: null,
    });
    const { DefaultApiV1Service } = await import(
      "@/server/api/v1/default-service"
    );
    const scopedService = new DefaultApiV1Service();
    await expect(scopedService.getTask(taskId, "other-user")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(scopedService.getTask(taskId, "user-a")).resolves.toMatchObject({
      task_id: taskId,
    });

    await repository.acquireTaskItemUploadLease({
      taskId,
      itemId: firstItemId,
    });
    const partial = await repository.updateTaskItemUploadProgress({
      taskId,
      itemId: firstItemId,
      receivedBytes: 5,
      completed: true,
    });
    expect(partial.task.status).toBe("queued");
    expect(partial.task.phase).toBe("receiving");
    expect(partial.items[0]?.status).toBe("queued");
    expect(partial.items[0]?.phase).toBe("waiting_for_seal");

    await repository.acquireTaskItemUploadLease({
      taskId,
      itemId: secondItemId,
    });
    await expect(repository.sealTaskIfComplete(taskId)).rejects.toMatchObject({
      status: 409,
    });
    const received = await repository.updateTaskItemUploadProgress({
      taskId,
      itemId: secondItemId,
      receivedBytes: 15,
      completed: true,
    });
    expect(received.task.phase).toBe("waiting_for_seal");
    expect(received.task.progressPercent).toBe(100);

    const sealed = await repository.sealTaskIfComplete(taskId);
    expect(sealed.task.status).toBe("running");
    expect(sealed.task.phase).toBe("validating");
    expect(sealed.task.doneItems).toBe(0);
    expect(sealed.items.every((item) => item.phase === "validating")).toBe(true);

    const queuedJobs = await migrationConnection.db
      .select()
      .from(jobs)
      .where(eq(jobs.taskId, taskId));
    expect(queuedJobs).toHaveLength(2);
    expect(queuedJobs.every((job) => job.type === "validate")).toBe(true);
    await expect(
      repository.updateTaskItemUploadProgress({
        taskId,
        itemId: firstItemId,
        receivedBytes: 5,
        completed: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("MCP 幂等键持久化原任务，并串行化同键并发请求", async () => {
    const { databaseMcpIdempotencyStore } = await import(
      "@/server/mcp/idempotency"
    );
    const taskId = crypto.randomUUID();
    const now = new Date();
    const handler = vi.fn(async () => {
      await migrationConnection.db.insert(tasks).values({
        id: taskId,
        type: "publish",
        userId: "user-001",
        status: "queued",
        phase: "publishing",
        createdAt: now,
        updatedAt: now,
      });
      return { task_id: taskId, status: "queued" };
    });
    const input = {
      operation: "publish_asset",
      userId: "user-001",
      key: "publish-once",
      request: { asset_id: crypto.randomUUID() },
      retentionDays: 7,
    };

    const [first, concurrentReplay] = await Promise.all([
      databaseMcpIdempotencyStore.run(input, handler),
      databaseMcpIdempotencyStore.run(input, handler),
    ]);
    expect(first).toEqual({ task_id: taskId, status: "queued" });
    expect(concurrentReplay).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      databaseMcpIdempotencyStore.run(
        { ...input, request: { asset_id: crypto.randomUUID() } },
        handler,
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("并发 PUT 只获得一个租约，中断后进度归零并可完整重试", async () => {
    const taskId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await repository.createTaskWithItems({
      id: taskId,
      type: "upload",
      items: [
        {
          id: itemId,
          ordinal: 0,
          filename: "retry.jpg",
          totalBytes: 10,
          stagingPath: ".staging/retry.jpg",
        },
      ],
    });

    const leases = await Promise.allSettled([
      repository.acquireTaskItemUploadLease({ taskId, itemId }),
      repository.acquireTaskItemUploadLease({ taskId, itemId }),
    ]);
    expect(leases.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = leases.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });

    await repository.updateTaskItemUploadProgress({
      taskId,
      itemId,
      receivedBytes: 6,
    });
    expect(
      (await repository.getTaskWithItems(taskId)).items[0],
    ).toMatchObject({ phase: "uploading", receivedBytes: 6 });

    expect(
      await repository.releaseTaskItemUploadLease({ taskId, itemId }),
    ).toBe(true);
    const reset = await repository.getTaskWithItems(taskId);
    expect(reset.task).toMatchObject({
      phase: "receiving",
      receivedBytes: 0,
      progressPercent: 0,
    });
    expect(reset.items[0]).toMatchObject({
      status: "queued",
      phase: "receiving",
      receivedBytes: 0,
    });

    const retry = await repository.acquireTaskItemUploadLease({ taskId, itemId });
    expect(retry.state).toBe("acquired");
    const completed = await repository.updateTaskItemUploadProgress({
      taskId,
      itemId,
      receivedBytes: 10,
      completed: true,
    });
    expect(completed.task).toMatchObject({
      phase: "waiting_for_seal",
      receivedBytes: 10,
      progressPercent: 100,
    });
  });

  test("请求体中断会释放租约、清理暂存文件并允许 PUT 重试", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assets-upload-"));
    const previousMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaRoot;
    try {
      const { DefaultApiV1Service } = await import(
        "@/server/api/v1/default-service"
      );
      const service = new DefaultApiV1Service();
      const payloadSize = 4 * 1024 * 1024 + 1;
      const created = await service.createUploadTask({
        user_id: null,
        callback_url: null,
        auto_publish: false,
        items: [
          {
            filename: "interrupted.jpg",
            size_bytes: payloadSize,
            content_type: "image/jpeg",
          },
        ],
      });
      const itemId = created.items[0]!.item_id;
      let pullCount = 0;
      const interrupted = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            return;
          }
          controller.error(new Error("client disconnected"));
        },
      });

      await expect(
        service.receiveUploadItem({
          taskId: created.task_id,
          itemId,
          body: interrupted,
          contentLength: payloadSize,
          contentType: "image/jpeg",
        }),
      ).rejects.toThrow("client disconnected");
      const afterInterruption = await repository.getTaskWithItems(created.task_id);
      expect(afterInterruption.task).toMatchObject({
        phase: "receiving",
        receivedBytes: 0,
      });
      expect(afterInterruption.items[0]).toMatchObject({
        status: "queued",
        phase: "receiving",
        receivedBytes: 0,
      });

      const completeBody = new Uint8Array(payloadSize);
      const retried = await service.receiveUploadItem({
        taskId: created.task_id,
        itemId,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(completeBody);
            controller.close();
          },
        }),
        contentLength: payloadSize,
        contentType: "image/jpeg",
      });
      expect(retried).toMatchObject({
        phase: "waiting_for_seal",
        received_bytes: payloadSize,
      });
      const stagingFiles = await fs.readdir(
        path.join(mediaRoot, ".staging", created.task_id),
      );
      expect(stagingFiles).toEqual([`${itemId}.jpg`]);
    } finally {
      if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = previousMediaRoot;
      await fs.rm(mediaRoot, { recursive: true, force: true });
    }
  });

  test("同一 item 的重叠 PUT 会在服务层返回 conflict", async () => {
    const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assets-race-"));
    const previousMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaRoot;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const { DefaultApiV1Service } = await import(
        "@/server/api/v1/default-service"
      );
      const service = new DefaultApiV1Service();
      const created = await service.createUploadTask({
        user_id: null,
        callback_url: null,
        auto_publish: false,
        items: [
          {
            filename: "race.jpg",
            size_bytes: 3,
            content_type: "image/jpeg",
          },
        ],
      });
      const itemId = created.items[0]!.item_id;
      const firstBody = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          streamController.enqueue(new Uint8Array([1]));
        },
      });
      const firstPut = service.receiveUploadItem({
        taskId: created.task_id,
        itemId,
        body: firstBody,
        contentLength: 3,
        contentType: "image/jpeg",
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await repository.getTaskWithItems(created.task_id);
        if (current.items[0]?.phase === "uploading") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        (await repository.getTaskWithItems(created.task_id)).items[0]?.phase,
      ).toBe("uploading");
      await expect(
        service.receiveUploadItem({
          taskId: created.task_id,
          itemId,
          body: new ReadableStream<Uint8Array>({
            start(secondController) {
              secondController.enqueue(new Uint8Array([1, 2, 3]));
              secondController.close();
            },
          }),
          contentLength: 3,
          contentType: "image/jpeg",
        }),
      ).rejects.toMatchObject({ code: "conflict", status: 409 });

      controller!.enqueue(new Uint8Array([2, 3]));
      controller!.close();
      controller = undefined;
      await expect(firstPut).resolves.toMatchObject({
        phase: "waiting_for_seal",
        received_bytes: 3,
      });
    } finally {
      if (controller) controller.error(new Error("test cleanup"));
      if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = previousMediaRoot;
      await fs.rm(mediaRoot, { recursive: true, force: true });
    }
  });

  test("user_id 为空表示公共素材，个人删除会将素材释放到公共库", async () => {
    const publicId = crypto.randomUUID();
    const privateId = crypto.randomUUID();
    for (const [assetId, userId] of [
      [publicId, null],
      [privateId, "user-b"],
    ] as const) {
      await repository.createAsset({
        assetId,
        userId,
        name: assetId,
        originalFilename: `${assetId}.jpg`,
        originalPath: `/tmp/${assetId}.jpg`,
        mimeType: "image/jpeg",
        mediaType: "image",
        sizeBytes: 10,
        directPublish: true,
        enqueueAnalysis: false,
      });
      await migrationConnection.db
        .update(assets)
        .set({ processingStatus: "completed", reviewStatus: "published" })
        .where(eq(assets.id, assetId));
    }

    expect((await repository.listAssets()).items.map((item) => item.id)).toEqual([
      publicId,
    ]);
    expect(
      (await repository.listAssets({ userId: "user-b" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([privateId]);

    await repository.releaseAssetToPublic(privateId, "user-b");
    const publicIds = (await repository.listAssets()).items.map((item) => item.id);
    expect(new Set(publicIds)).toEqual(new Set([publicId, privateId]));
  });

  test("用户资源用量精确汇总素材对象，并排除公共素材和完整父视频", async () => {
    const userId = "usage-user";
    const now = new Date();
    const parentObjectId = crypto.randomUUID();
    const imageObjectId = crypto.randomUUID();
    const firstSegmentObjectId = crypto.randomUUID();
    const secondSegmentObjectId = crypto.randomUUID();
    const firstThumbnailObjectId = crypto.randomUUID();
    const secondThumbnailObjectId = crypto.randomUUID();
    const caseDistinctObjectId = crypto.randomUUID();
    const parentSourceId = crypto.randomUUID();
    await migrationConnection.db.insert(mediaObjects).values([
      {
        id: parentObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${parentObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 1_000,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: imageObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${imageObjectId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 20,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: firstSegmentObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${firstSegmentObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 30,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondSegmentObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${secondSegmentObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 40,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: firstThumbnailObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${firstThumbnailObjectId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 3,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondThumbnailObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${secondThumbnailObjectId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 4,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: caseDistinctObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `usage/${caseDistinctObjectId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 700,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await migrationConnection.db.insert(videoSources).values({
      id: parentSourceId,
      userId,
      mediaObjectId: parentObjectId,
      originalFilename: "parent.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_000,
      status: "done",
      createdAt: now,
      updatedAt: now,
    });

    const expectedItems = [
      {
        id: crypto.randomUUID(),
        name: "usage-image",
        mediaType: "image" as const,
        sizeBytes: 20,
        mediaObjectId: imageObjectId,
        thumbnailMediaObjectId: null,
      },
      {
        id: crypto.randomUUID(),
        name: "usage-segment-1",
        mediaType: "video" as const,
        sizeBytes: 30,
        mediaObjectId: firstSegmentObjectId,
        thumbnailMediaObjectId: firstThumbnailObjectId,
      },
      {
        id: crypto.randomUUID(),
        name: "usage-segment-2",
        mediaType: "video" as const,
        sizeBytes: 40,
        mediaObjectId: secondSegmentObjectId,
        thumbnailMediaObjectId: secondThumbnailObjectId,
      },
    ];
    for (const item of expectedItems) {
      await repository.createAsset({
        assetId: item.id,
        userId,
        videoSourceId: item.mediaType === "video" ? parentSourceId : null,
        mediaObjectId: item.mediaObjectId,
        name: item.name,
        originalFilename: `${item.name}.${item.mediaType === "video" ? "mp4" : "jpg"}`,
        originalPath: `usage/${item.mediaObjectId}`,
        mimeType: item.mediaType === "video" ? "video/mp4" : "image/jpeg",
        mediaType: item.mediaType,
        sizeBytes: item.sizeBytes,
        directPublish: true,
        enqueueAnalysis: false,
      });
      if (item.thumbnailMediaObjectId) {
        await migrationConnection.db
          .update(assets)
          .set({ thumbnailMediaObjectId: item.thumbnailMediaObjectId })
          .where(eq(assets.id, item.id));
      }
    }
    for (const [otherUserId, name, sizeBytes, mediaObjectId] of [
      [null, "public-image", 500, null],
      ["USAGE-USER", "case-distinct-image", 700, caseDistinctObjectId],
      ["usage-user-other", "prefix-image", 900, null],
    ] as const) {
      await repository.createAsset({
        assetId: crypto.randomUUID(),
        userId: otherUserId,
        mediaObjectId,
        name,
        originalFilename: `${name}.jpg`,
        originalPath: `/tmp/${name}.jpg`,
        mimeType: "image/jpeg",
        mediaType: "image",
        sizeBytes,
        directPublish: true,
        enqueueAnalysis: false,
      });
    }

    const deletedAssetId = crypto.randomUUID();
    await repository.createAsset({
      assetId: deletedAssetId,
      userId,
      mediaObjectId: imageObjectId,
      name: "deleted-image",
      originalFilename: "deleted-image.jpg",
      originalPath: "usage/deleted-image.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 20,
      directPublish: true,
      enqueueAnalysis: false,
    });
    await migrationConnection.db
      .update(assets)
      .set({ reviewStatus: "deleted", deletedAt: now })
      .where(eq(assets.id, deletedAssetId));

    const usage = await repository.summarizeUserStorage(`  ${userId}  `);
    expect(usage).toMatchObject({
      userId,
      totalFiles: 3,
      totalBytes: 97,
      imageBytes: 20,
      videoBytes: 77,
    });
    expect(
      usage.items
        .map(({ assetId, name, mediaType, mediaBytes, thumbnailBytes, totalBytes }) => ({
          assetId,
          name,
          mediaType,
          mediaBytes,
          thumbnailBytes,
          totalBytes,
        }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId)),
    ).toEqual(
      expectedItems
        .map(({ id, name, mediaType, sizeBytes, thumbnailMediaObjectId }) => ({
          assetId: id,
          name,
          mediaType,
          mediaBytes: sizeBytes,
          thumbnailBytes:
            thumbnailMediaObjectId === firstThumbnailObjectId
              ? 3
              : thumbnailMediaObjectId === secondThumbnailObjectId
                ? 4
                : 0,
          totalBytes:
            sizeBytes +
            (thumbnailMediaObjectId === firstThumbnailObjectId
              ? 3
              : thumbnailMediaObjectId === secondThumbnailObjectId
                ? 4
                : 0),
        }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId)),
    );
    await expect(repository.summarizeUserStorage("USAGE-USER")).resolves.toMatchObject({
      totalFiles: 1,
      totalBytes: 700,
      imageBytes: 700,
      videoBytes: 0,
    });
    await expect(repository.summarizeUserStorage("missing-user")).resolves.toMatchObject({
      totalFiles: 0,
      totalBytes: 0,
      imageBytes: 0,
      videoBytes: 0,
      items: [],
    });
    await expect(repository.summarizeUserStorage("   ")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    // 同毫秒创建的素材依靠 UUID 作为第二排序键；翻页期间插入更新素材也不漂移。
    await migrationConnection.db
      .update(assets)
      .set({ createdAt: now })
      .where(inArray(assets.id, expectedItems.map((item) => item.id)));
    const firstPage = await repository.listUserMediaPage(userId, null, 2);
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.nextCursor).toEqual({
      createdAt: now,
      assetId: firstPage.items.at(-1)?.assetId,
    });

    const newerAssetId = crypto.randomUUID();
    await repository.createAsset({
      assetId: newerAssetId,
      userId,
      mediaObjectId: imageObjectId,
      name: "inserted-between-pages",
      originalFilename: "inserted-between-pages.jpg",
      originalPath: "usage/inserted-between-pages.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 20,
      directPublish: true,
      enqueueAnalysis: false,
    });
    await migrationConnection.db
      .update(assets)
      .set({ createdAt: new Date(now.getTime() + 1_000) })
      .where(eq(assets.id, newerAssetId));

    const secondPage = await repository.listUserMediaPage(
      userId,
      firstPage.nextCursor,
      2,
    );
    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.assetId)),
    ).toEqual(new Set(expectedItems.map((item) => item.id)));
  });

  test("修改类 API 会持久化任务与 durable job", async () => {
    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      name: "mutation target",
      originalFilename: "target.jpg",
      originalPath: "/tmp/target.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });

    const created = await repository.createMutationTask({
      type: "update",
      assetId,
      payload: { name: "updated" },
    });
    expect(created.task.type).toBe("update");
    expect(created.task.phase).toBe("updating");
    const [job] = await migrationConnection.db
      .select()
      .from(jobs)
      .where(eq(jobs.taskId, created.task.id));
    expect(job?.type).toBe("update");
    expect(job?.status).toBe("queued");

    const [count] = await migrationConnection.db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(jobs);
    expect(count?.value).toBe(1);
  });

  test("转公共提交后，排队中的旧用户更新不能越过所有权检查", async () => {
    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      userId: "owner-a",
      name: "original",
      originalFilename: "owned.jpg",
      originalPath: "/tmp/owned.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });

    const blocker = await migrationConnection.pool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query("UPDATE assets SET user_id = NULL WHERE id = ?", [assetId]);
      const updateAttempt = repository
        .updateAssetMetadata(
          assetId,
          { name: "stale update", description: "", tags: [] },
          { userId: "owner-a" },
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      // 给另一个连接足够时间进入 SELECT ... FOR UPDATE 的等待队列。
      await new Promise((resolve) => setTimeout(resolve, 500));
      await blocker.commit();

      const outcome = await updateAttempt;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ status: 404 });
    } finally {
      await blocker.rollback().catch(() => undefined);
      blocker.release();
    }
    const [stored] = await migrationConnection.db
      .select({ userId: assets.userId, name: assets.name })
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(stored).toEqual({ userId: null, name: "original" });
  }, 30_000);

  test("删除提交后，排队中的 publish 不能把 deleted 素材复活", async () => {
    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      name: "to delete",
      originalFilename: "delete.jpg",
      originalPath: "/tmp/delete.jpg",
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: false,
      enqueueAnalysis: false,
    });
    await migrationConnection.db
      .update(assets)
      .set({ processingStatus: "completed" })
      .where(eq(assets.id, assetId));

    const blocker = await migrationConnection.pool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "UPDATE assets SET review_status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [assetId],
      );
      const publishAttempt = repository
        .publishAsset(assetId, { userId: null })
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await blocker.commit();

      const outcome = await publishAttempt;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ status: 404 });
    } finally {
      await blocker.rollback().catch(() => undefined);
      blocker.release();
    }
    const [stored] = await migrationConnection.db
      .select({ reviewStatus: assets.reviewStatus })
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(stored?.reviewStatus).toBe("deleted");
  }, 30_000);

  test("同一父视频的切片并发删除时只由最后一个切片回收父视频", async () => {
    const now = new Date();
    const parentObjectId = crypto.randomUUID();
    const firstObjectId = crypto.randomUUID();
    const secondObjectId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const firstAssetId = crypto.randomUUID();
    const secondAssetId = crypto.randomUUID();
    await migrationConnection.db.insert(mediaObjects).values([
      {
        id: parentObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `tests/${parentObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 30,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: firstObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `tests/${firstObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 10,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondObjectId,
        provider: "zos",
        bucket: "test",
        objectKey: `tests/${secondObjectId}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 20,
        status: "persisted",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await migrationConnection.db.insert(videoSources).values({
      id: sourceId,
      mediaObjectId: parentObjectId,
      originalFilename: "parent.mp4",
      mimeType: "video/mp4",
      sizeBytes: 30,
      status: "done",
      createdAt: now,
      updatedAt: now,
    });
    for (const [assetId, mediaObjectId, segmentIndex] of [
      [firstAssetId, firstObjectId, 0],
      [secondAssetId, secondObjectId, 1],
    ] as const) {
      await repository.createAsset({
        assetId,
        videoSourceId: sourceId,
        mediaObjectId,
        segmentIndex,
        name: `segment-${segmentIndex}`,
        originalFilename: `segment-${segmentIndex}.mp4`,
        originalPath: `zos://tests/${mediaObjectId}.mp4`,
        mimeType: "video/mp4",
        mediaType: "video",
        sizeBytes: segmentIndex === 0 ? 10 : 20,
        directPublish: true,
        enqueueAnalysis: false,
      });
      await migrationConnection.db
        .update(assets)
        .set({ processingStatus: "completed", reviewStatus: "published" })
        .where(eq(assets.id, assetId));
    }

    async function deletionJob(assetId: string) {
      const created = await repository.createMutationTask({
        type: "delete",
        assetId,
        payload: { userId: null },
      });
      const [storedJob] = await migrationConnection.db
        .select()
        .from(jobs)
        .where(eq(jobs.taskId, created.task.id));
      if (!storedJob) throw new Error("删除 job 未创建。 ");
      await migrationConnection.db
        .update(jobs)
        .set({ status: "running", attempt: 1 })
        .where(eq(jobs.id, storedJob.id));
      return {
        id: storedJob.id,
        taskId: storedJob.taskId,
        assetId: storedJob.assetId,
        type: storedJob.type,
        attempt: 1,
        payload: storedJob.payload,
      };
    }

    const [firstJob, secondJob] = await Promise.all([
      deletionJob(firstAssetId),
      deletionJob(secondAssetId),
    ]);
    const deleteObject = vi.fn(async (key: string) => {
      void key;
    });
    const storage = { deleteObject } as unknown as ObjectStorage;
    deleteAnalysisMock.mockClear();
    const { processMutationJob } = await import(
      "@/server/services/mutation-pipeline"
    );
    await Promise.all([
      processMutationJob(firstJob, storage),
      processMutationJob(secondJob, storage),
    ]);

    expect(
      await migrationConnection.db
        .select()
        .from(assets)
        .where(inArray(assets.id, [firstAssetId, secondAssetId])),
    ).toHaveLength(0);
    expect(
      await migrationConnection.db
        .select()
        .from(videoSources)
        .where(eq(videoSources.id, sourceId)),
    ).toHaveLength(0);
    expect(
      await migrationConnection.db
        .select()
        .from(mediaObjects)
        .where(
          inArray(mediaObjects.id, [
            parentObjectId,
            firstObjectId,
            secondObjectId,
          ]),
        ),
    ).toHaveLength(0);
    expect(new Set(deleteObject.mock.calls.map(([key]) => key))).toEqual(
      new Set([
        `tests/${parentObjectId}.mp4`,
        `tests/${firstObjectId}.mp4`,
        `tests/${secondObjectId}.mp4`,
      ]),
    );
    expect(deleteAnalysisMock).toHaveBeenCalledTimes(2);

    const taskRows = await migrationConnection.db
      .select({ result: tasks.result })
      .from(tasks)
      .where(inArray(tasks.id, [firstJob.taskId!, secondJob.taskId!]));
    expect(
      taskRows.filter(
        (row) => row.result?.parent_video_reclaimed === true,
      ),
    ).toHaveLength(1);
    const durableJobs = await migrationConnection.db
      .select({ status: jobs.status, assetId: jobs.assetId })
      .from(jobs)
      .where(inArray(jobs.id, [firstJob.id, secondJob.id]));
    expect(durableJobs).toEqual(
      expect.arrayContaining([
        { status: "done", assetId: null },
        { status: "done", assetId: null },
      ]),
    );
  }, 30_000);

  test("公共删除在外部存储短暂失败后可幂等重试并完成数据库收尾", async () => {
    const now = new Date();
    const objectId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const objectKey = `tests/${objectId}.jpg`;
    await migrationConnection.db.insert(mediaObjects).values({
      id: objectId,
      provider: "zos",
      bucket: "test",
      objectKey,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      status: "persisted",
      createdAt: now,
      updatedAt: now,
    });
    await repository.createAsset({
      assetId,
      mediaObjectId: objectId,
      name: "retry delete",
      originalFilename: "retry.jpg",
      originalPath: `zos://${objectKey}`,
      mimeType: "image/jpeg",
      mediaType: "image",
      sizeBytes: 10,
      directPublish: true,
      enqueueAnalysis: false,
    });
    await migrationConnection.db
      .update(assets)
      .set({ processingStatus: "completed", reviewStatus: "published" })
      .where(eq(assets.id, assetId));
    const queuedPublish = await repository.createMutationTask({
      type: "publish",
      assetId,
      payload: { userId: null },
    });
    const created = await repository.createMutationTask({
      type: "delete",
      assetId,
      payload: { userId: null },
    });
    const [storedJob] = await migrationConnection.db
      .select()
      .from(jobs)
      .where(eq(jobs.taskId, created.task.id));
    if (!storedJob) throw new Error("删除 job 未创建。");
    await migrationConnection.db
      .update(jobs)
      .set({ status: "running", attempt: 1 })
      .where(eq(jobs.id, storedJob.id));
    const job = { ...storedJob, status: "running" as const, attempt: 1 };
    let storageAttempt = 0;
    const deleteObject = vi.fn(async () => {
      storageAttempt += 1;
      if (storageAttempt === 1) throw new Error("temporary ZOS failure");
    });
    const storage = { deleteObject } as unknown as ObjectStorage;
    deleteAnalysisMock.mockClear();
    const { processMutationJob } = await import(
      "@/server/services/mutation-pipeline"
    );

    await expect(processMutationJob(job, storage)).rejects.toThrow(
      "temporary ZOS failure",
    );
    const [reserved] = await migrationConnection.db
      .select({ reviewStatus: assets.reviewStatus })
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(reserved?.reviewStatus).toBe("deleted");

    await processMutationJob(job, storage);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteAnalysisMock).toHaveBeenCalledTimes(2);
    expect(
      await migrationConnection.db
        .select()
        .from(assets)
        .where(eq(assets.id, assetId)),
    ).toHaveLength(0);
    const [finishedTask] = await migrationConnection.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, created.task.id));
    const [finishedJob] = await migrationConnection.db
      .select({ status: jobs.status, assetId: jobs.assetId, payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, storedJob.id));
    expect(finishedTask?.status).toBe("done");
    expect(finishedJob).toMatchObject({
      status: "done",
      assetId: null,
      payload: { assetId },
    });

    const [publishJob] = await migrationConnection.db
      .select()
      .from(jobs)
      .where(eq(jobs.taskId, queuedPublish.task.id));
    expect(publishJob).toMatchObject({
      status: "queued",
      assetId: null,
      payload: { assetId },
    });
    await migrationConnection.db
      .update(jobs)
      .set({ status: "running", attempt: 1 })
      .where(eq(jobs.id, publishJob!.id));
    await expect(
      processMutationJob(
        {
          id: publishJob!.id,
          taskId: publishJob!.taskId,
          assetId: publishJob!.assetId,
          type: publishJob!.type,
          attempt: 1,
          payload: publishJob!.payload,
        },
        storage,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const [failedPublishTask] = await migrationConnection.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, queuedPublish.task.id));
    expect(failedPublishTask?.status).toBe("failed");
  }, 30_000);

  test("只清理过期终态任务，并保留父视频且清空短期追溯引用", async () => {
    const taskId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    await repository.createTaskWithItems({
      id: taskId,
      type: "upload",
      expiresAt: new Date(Date.now() - 60_000),
      items: [
        {
          id: itemId,
          ordinal: 0,
          filename: "source.mp4",
          totalBytes: 10,
          stagingPath: "/tmp/source.mp4",
        },
      ],
    });
    const now = new Date();
    await migrationConnection.db.insert(videoSources).values({
      id: sourceId,
      taskId,
      taskItemId: itemId,
      originalFilename: "source.mp4",
      mimeType: "video/mp4",
      sizeBytes: 10,
      createdAt: now,
      updatedAt: now,
    });
    await migrationConnection.db
      .update(tasks)
      .set({ status: "done", phase: "done", finishedAt: now, updatedAt: now })
      .where(eq(tasks.id, taskId));

    expect(await repository.deleteExpiredTasks(now)).toBe(1);
    const [source] = await migrationConnection.db
      .select()
      .from(videoSources)
      .where(eq(videoSources.id, sourceId));
    expect(source?.taskId).toBeNull();
    expect(source?.taskItemId).toBeNull();
  });

  test("超过 staging 保留期的未封存上传会失败并保留可查询原因", async () => {
    const taskId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await repository.createTaskWithItems({
      id: taskId,
      type: "upload",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      items: [
        {
          id: itemId,
          ordinal: 0,
          filename: "abandoned.jpg",
          totalBytes: 10,
          stagingPath: ".staging/abandoned.jpg",
        },
      ],
    });
    const now = new Date();
    await migrationConnection.db
      .update(tasks)
      .set({ createdAt: new Date(now.getTime() - 2_000) })
      .where(eq(tasks.id, taskId));

    const { expireAbandonedUploadTasks } = await import(
      "@/server/services/staging-cleanup"
    );
    expect(await expireAbandonedUploadTasks(now, 1_000)).toBe(1);

    const [task] = await migrationConnection.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const [item] = await migrationConnection.db
      .select()
      .from(taskItems)
      .where(eq(taskItems.id, itemId));
    expect(task).toMatchObject({
      status: "failed",
      phase: "finished",
      failedItems: 1,
    });
    expect(item).toMatchObject({
      status: "failed",
      phase: "finished",
      errorCode: "task_expired",
    });
  });

  test("统一查询在 count 和分页前应用多值过滤及标签、关键词 AND 语义", async () => {
    async function seedAsset(input: {
      name: string;
      userId?: string;
      mediaType?: "image" | "video";
      processingStatus?: "completed" | "failed";
      reviewStatus?: "published" | "pending_review";
      tags: Array<{ category: string; value: string }>;
    }) {
      const id = crypto.randomUUID();
      await repository.createAsset({
        assetId: id,
        userId: input.userId,
        name: input.name,
        originalFilename: `${input.name}.${input.mediaType === "video" ? "mp4" : "jpg"}`,
        originalPath: `/tmp/${id}`,
        mimeType: input.mediaType === "video" ? "video/mp4" : "image/jpeg",
        mediaType: input.mediaType ?? "image",
        sizeBytes: 10,
        directPublish: true,
        enqueueAnalysis: false,
      });
      await repository.updateAssetMetadata(
        id,
        { name: input.name, description: "", tags: input.tags },
        { includeAllUsers: true },
      );
      await migrationConnection.db
        .update(assets)
        .set({
          processingStatus: input.processingStatus ?? "completed",
          reviewStatus: input.reviewStatus ?? "published",
        })
        .where(eq(assets.id, id));
      return id;
    }

    const commonTags = [
      { category: "scene", value: "海边" },
      { category: "object", value: "小船" },
      { category: "color", value: "Blue" },
    ];
    const first = await seedAsset({ name: "first", tags: commonTags });
    const second = await seedAsset({ name: "second", tags: commonTags });
    await seedAsset({
      name: "missing-keyword",
      tags: commonTags.filter((tag) => tag.category !== "object"),
    });
    await seedAsset({ name: "private", userId: "user-a", tags: commonTags });
    await seedAsset({ name: "video", mediaType: "video", tags: commonTags });
    await seedAsset({
      name: "failed",
      processingStatus: "failed",
      tags: commonTags,
    });
    await seedAsset({
      name: "pending",
      reviewStatus: "pending_review",
      tags: commonTags,
    });
    await seedAsset({
      name: "wrong-exact-tag",
      tags: commonTags.map((tag) =>
        tag.category === "color" ? { ...tag, value: "Red" } : tag,
      ),
    });

    const options = {
      limit: 1,
      includeTagStatistics: true,
      mediaTypes: ["image" as const],
      processingStatuses: ["completed" as const],
      reviewStatuses: ["published" as const],
      tags: [
        { category: "color", value: "blue" },
        { category: "scene", value: "海边" },
      ],
      keywords: ["海边", "小船"],
    };
    const firstPage = await repository.queryAssetsPage(options);
    const secondPage = await repository.queryAssetsPage({ ...options, page: 2 });

    expect(firstPage.total).toBe(2);
    expect(firstPage.totalPages).toBe(2);
    expect(secondPage.total).toBe(2);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))).toEqual(
      new Set([first, second]),
    );
    const expectedStatistics = {
      total_assets: 2,
      assets_with_tags: 2,
      assets_without_tags: 0,
      average_tags_per_asset: 3,
      maximum_tags_per_asset: 3,
    };
    expect(firstPage.tagStatistics).toMatchObject(expectedStatistics);
    expect(secondPage.tagStatistics).toMatchObject(expectedStatistics);
    expect(firstPage.tagStatistics?.top_tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "object",
          value: "小船",
          asset_count: 2,
          asset_share: 1,
        }),
      ]),
    );
    expect(secondPage.tagStatistics).toEqual(firstPage.tagStatistics);

    const withoutStatistics = await repository.queryAssetsPage({
      ...options,
      includeTagStatistics: false,
    });
    expect(withoutStatistics).not.toHaveProperty("tagStatistics");

    const allFiltered = await repository.queryAssetsPage({
      includeAllUsers: true,
      limit: 100,
      mediaTypes: ["image", "video"],
      processingStatuses: ["completed", "failed"],
      reviewStatuses: ["published", "pending_review"],
      tags: options.tags,
      keywords: options.keywords,
    });
    expect(allFiltered.total).toBe(6);
    expect(
      (await repository.queryAssetsPage({
        ...options,
        userId: "user-a",
        limit: 100,
      })).total,
    ).toBe(1);
    const scopedEmptySearch = await repository.queryAssetsPage({
      ...options,
      userId: "user-without-assets",
      limit: 100,
    });
    expect(scopedEmptySearch).toMatchObject({
      items: [],
      total: 0,
      search: {
        mode: "keyword",
        reason: "no_candidates",
        max_score: null,
      },
    });
    expect(scopedEmptySearch.search?.message).toBeTruthy();
    expect(
      (await repository.queryAssetsPage({
        excludeUserId: "user-a",
        limit: 100,
        mediaTypes: ["image", "video"],
        processingStatuses: ["completed", "failed"],
        reviewStatuses: ["published", "pending_review"],
        tags: options.tags,
        keywords: options.keywords,
      })).total,
    ).toBe(5);
    const beyondLastPage = await repository.queryAssetsPage({
      ...options,
      page: 999,
    });
    expect(beyondLastPage.items).toEqual([]);
    expect(beyondLastPage.page).toBe(999);

    const relevantAiAsset = await seedAsset({
      name: "ai-relevant",
      tags: [{ category: "object", value: "AI" }],
    });
    const irrelevantAiAsset = await seedAsset({
      name: "ai-irrelevant",
      tags: [{ category: "object", value: "AI" }],
    });
    searchAnalysisMock.mockImplementation(
      async (_query: string, _limit: number, candidateIds?: string[]) =>
        new Map(
          (candidateIds ?? []).map((assetId) => [
            assetId,
            assetId === relevantAiAsset ? 0.9 : 0.1,
          ]),
        ),
    );
    const broadAiSearch = await repository.queryAssetsPage({
      keywords: ["AI"],
      limit: 100,
      includeTagStatistics: true,
    });
    expect(broadAiSearch.items.map((item) => item.id)).toEqual([
      relevantAiAsset,
    ]);
    expect(broadAiSearch).toMatchObject({
      total: 1,
      totalPages: 1,
      search: {
        mode: "hybrid",
        threshold: 0.65,
        max_score: 0.94,
        reason: "matched",
        message: null,
      },
    });
    expect(broadAiSearch.items[0]).toMatchObject({
      searchScore: 0.94,
      keywordScore: 1,
      semanticScore: 0.9,
      matchType: "hybrid",
      matchedTerms: ["ai"],
      matchedCategories: ["object"],
    });
    expect(broadAiSearch.tagStatistics?.total_assets).toBe(1);
    expect(broadAiSearch.items.some((item) => item.id === irrelevantAiAsset)).toBe(
      false,
    );

    const typoAsset = await seedAsset({
      name: "typo-fallback",
      tags: [{ category: "scene", value: "城市" }],
    });
    const weakContainsAsset = await seedAsset({
      name: "weak-contains",
      tags: [{ category: "style", value: "古城巿风光" }],
    });
    const typoSearch = await repository.queryAssetsPage({
      keywords: ["城巿"],
      limit: 100,
    });
    expect(typoSearch.items.map((item) => item.id)).toEqual([typoAsset]);
    expect(typoSearch).toMatchObject({
      total: 1,
      search: {
        mode: "keyword",
        threshold: 0.4,
        max_score: 0.55,
        reason: "matched",
        message: null,
      },
    });
    expect(typoSearch.items[0]).toMatchObject({
      searchScore: 0.55,
      keywordScore: 0.55,
      matchType: "typo",
      matchedTerms: ["城巿"],
      matchedCategories: ["scene"],
    });
    expect(typoSearch.items.some((item) => item.id === weakContainsAsset)).toBe(
      false,
    );

    searchAnalysisMock.mockImplementation(
      async (_query: string, _limit: number, candidateIds?: string[]) =>
        new Map((candidateIds ?? []).map((assetId) => [assetId, 0.9])),
    );
    const semantic = await repository.queryAssetsPage({
      ...options,
      limit: 100,
      semanticQuery: "海边的小船",
      includeTagStatistics: true,
    });
    expect(new Set(semantic.items.map((item) => item.id))).toEqual(
      new Set([first, second]),
    );
    expect(semantic).toMatchObject({ page: 1, total: 2, totalPages: 1 });
    expect(semantic.tagStatistics).toMatchObject(expectedStatistics);
    expect(searchAnalysisMock).toHaveBeenLastCalledWith(
      "海边的小船",
      800,
      expect.arrayContaining([first, second]),
      { minimumSimilarity: 0 },
    );
    const semanticCandidateIds = searchAnalysisMock.mock.lastCall?.[2] as string[];
    expect(new Set(semanticCandidateIds)).toEqual(new Set([first, second]));
  }, 30_000);

  test("兼容匹配任务持久化、复用语义召回并投递 camelCase 回调", async () => {
    const assetId = crypto.randomUUID();
    await repository.createAsset({
      assetId,
      userId: "759",
      name: "夕阳下的人物",
      originalFilename: "sunset.mp4",
      originalPath: `/tmp/${assetId}`,
      mimeType: "video/mp4",
      mediaType: "video",
      sizeBytes: 10,
      directPublish: true,
      enqueueAnalysis: false,
    });
    await repository.updateAssetMetadata(
      assetId,
      {
        name: "夕阳下的人物",
        description: "夕阳下女性剪影，符合回忆意境",
        tags: [],
      },
      { includeAllUsers: true },
    );
    await migrationConnection.db
      .update(assets)
      .set({ processingStatus: "completed", reviewStatus: "published" })
      .where(eq(assets.id, assetId));
    searchAnalysisMock.mockResolvedValue(new Map([[assetId, 0.91]]));

    const { compatibilityMatchRequestSchema } = await import("@/shared/contracts");
    const { processCompatibilityMatchJob } = await import(
      "@/server/services/compatibility-match"
    );
    const { processCallbackJob } = await import("@/server/services/callbacks");
    const request = compatibilityMatchRequestSchema.parse({
      asr: {
        transcripts: [
          {
            sentences: [
              {
                text: "如果能回到二十岁",
                words: [
                  {
                    text: "如果能回到二十岁",
                    begin_time: 320,
                    end_time: 1600,
                  },
                ],
              },
            ],
          },
        ],
      },
      asset_url_list: [],
      callback_url: "https://callback.invalid/api/media/callback",
      llm: JSON.stringify({
        segments: [
          {
            segment_id: 1,
            text: "如果能回到二十岁",
            high_light_word: "回到二十岁",
            level: 1,
            transition: "fade",
          },
        ],
      }),
      text: "如果能回到二十岁",
      business_id: "business-42",
    });

    const taskId = crypto.randomUUID();
    const matchJobId = crypto.randomUUID();
    const now = new Date();
    const matchPayload = {
      request,
      publicOrigin: "https://focus.example.com",
      callbackFields: { business_id: "business-42" },
    };
    await migrationConnection.db.insert(tasks).values({
      id: taskId,
      type: "match",
      status: "running",
      phase: "matching",
      callbackUrl: request.callback_url,
      totalItems: 1,
      createdAt: now,
      updatedAt: now,
    });
    await migrationConnection.db.insert(jobs).values({
      id: matchJobId,
      taskId,
      type: "match",
      status: "running",
      phase: "matching",
      payload: matchPayload,
      attempt: 1,
      availableAt: now,
      claimedAt: now,
      leaseOwner: "compatibility-match-test",
      createdAt: now,
      updatedAt: now,
    });
    await processCompatibilityMatchJob({
      id: matchJobId,
      taskId,
      assetId: null,
      type: "match",
      attempt: 1,
      payload: matchPayload,
      claimedAt: now,
      leaseOwner: "compatibility-match-test",
    });

    const [completedTask] = await migrationConnection.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(completedTask).toMatchObject({
      type: "match",
      status: "done",
      phase: "finished",
      result: {
        segments: [
          expect.objectContaining({
            segment_id: 1,
            keyword: "回到二十岁",
            group_id: [1, 1],
            start_time: 0.32,
            end_time: 1.6,
            transition: "fade",
            matched_candidate_type: "video",
            matched_candidate_desc: "夕阳下女性剪影，符合回忆意境",
            matched_candidate_score: 0.91,
            matched_candidate_reason: null,
            matched_candidate_message: null,
          }),
        ],
      },
    });
    expect(searchAnalysisMock).toHaveBeenCalledWith(
      "如果能回到二十岁",
      5,
      [assetId],
      { minimumSimilarity: 0 },
    );

    const [generatedCallback] = await migrationConnection.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.taskId, taskId), eq(jobs.type, "callback")))
      .limit(1);
    expect(generatedCallback?.payload).toMatchObject({
      compatibilityCallback: {
        business_id: "business-42",
        taskId,
        status: "success",
      },
    });
    const callbackJobId = crypto.randomUUID();
    await migrationConnection.db.insert(jobs).values({
      id: callbackJobId,
      taskId,
      type: "callback",
      status: "running",
      phase: "notifying",
      payload: generatedCallback!.payload,
      attempt: 1,
      availableAt: now,
      claimedAt: now,
      leaseOwner: "compatibility-callback-test",
      createdAt: now,
      updatedAt: now,
    });
    const callbackJob = {
      id: callbackJobId,
      taskId,
      assetId: null,
      type: "callback" as const,
      attempt: 1,
      payload: generatedCallback!.payload,
      claimedAt: now,
      leaseOwner: "compatibility-callback-test",
    };
    const callbackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    let callbackBodyJson = "";
    try {
      await processCallbackJob(callbackJob!);
      expect(callbackFetch).toHaveBeenCalledTimes(1);
      const [, fetchInit] = callbackFetch.mock.calls[0]!;
      callbackBodyJson = String(fetchInit?.body);
    } finally {
      callbackFetch.mockRestore();
    }
    const callbackBody = JSON.parse(callbackBodyJson) as {
      completed_at: string;
      result: { segments: Array<{ matched_candidate_url: string }> };
      [key: string]: unknown;
    };
    expect(callbackBody).toMatchObject({
      business_id: "business-42",
      taskId,
      status: "success",
      result: {
        segments: [
          expect.objectContaining({
            segment_id: 1,
            matched_candidate_type: "video",
            matched_candidate_score: 0.91,
            matched_candidate_reason: null,
            matched_candidate_message: null,
          }),
        ],
      },
    });
    expect(callbackBody.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/,
    );
    expect(callbackBody).not.toHaveProperty("asr");
    expect(callbackBody).not.toHaveProperty("llm");
    const matchedUrl = new URL(
      callbackBody.result.segments[0].matched_candidate_url,
    );
    expect(matchedUrl.origin).toBe("https://focus.example.com");
    expect(matchedUrl.pathname).toContain(`/api/v1/media/${assetId}`);
    expect(matchedUrl.searchParams.get("user_id")).toBe("759");
  }, 30_000);

  test("将失败的素材错误码与 asset_ids 向上聚合到 item 和 task", async () => {
    const now = new Date();
    const taskId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const okAssetId = crypto.randomUUID();
    const failedAssetId = crypto.randomUUID();
    await migrationConnection.db.insert(tasks).values({
      id: taskId,
      type: "upload",
      status: "running",
      phase: "analyzing",
      createdAt: now,
      updatedAt: now,
    });
    await migrationConnection.db.insert(taskItems).values({
      id: itemId,
      taskId,
      ordinal: 0,
      filename: "a.jpg",
      stagingPath: "/tmp/a.jpg",
      status: "running",
      phase: "analyzing",
      createdAt: now,
      updatedAt: now,
    });
    const insertAsset = (id: string, status: "completed" | "failed") =>
      migrationConnection.db.insert(assets).values({
        id,
        userId: "user-a",
        taskId,
        taskItemId: itemId,
        name: "a",
        description: "",
        mediaType: "image",
        originalFilename: "a.jpg",
        originalPath: "/tmp/a.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        reviewStatus: "published",
        processingStatus: status,
        failureCode: status === "failed" ? "model_response_invalid" : null,
        failureMessage: status === "failed" ? "模型返回内容无法验证。" : null,
        createdAt: now,
        updatedAt: now,
      });
    await insertAsset(okAssetId, "completed");
    await insertAsset(failedAssetId, "failed");

    await lifecycle.refreshTaskForAsset(failedAssetId);

    const [storedItem] = await migrationConnection.db
      .select()
      .from(taskItems)
      .where(eq(taskItems.id, itemId));
    expect(storedItem).toBeDefined();
    expect(storedItem?.status).toBe("failed");
    expect(storedItem?.errorCode).toBe("model_response_invalid");
    expect(storedItem?.errorDetails).toMatchObject({
      codes: ["model_response_invalid"],
      failedAssetIds: [failedAssetId],
    });

    const [storedTask] = await migrationConnection.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(storedTask).toBeDefined();
    expect(storedTask?.status).toBe("failed");
    expect(storedTask?.errorCode).toBe("model_response_invalid");
    expect(storedTask?.errorDetails).toMatchObject({
      codes: ["model_response_invalid"],
      failedItems: 1,
      failedAssetIds: [failedAssetId],
    });
  }, 30_000);
});
