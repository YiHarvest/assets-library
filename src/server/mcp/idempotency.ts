import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { and, eq, lte } from "drizzle-orm";
import { db, pool } from "@/server/db";
import { idempotencyRequests } from "@/server/db/schema";
import { ApiV1Error } from "@/server/api/errors";
import { auditLog, elapsedMilliseconds } from "@/server/observability/audit-log";

export interface McpIdempotencyInput {
  operation: string;
  userId: string;
  key?: string;
  request: unknown;
  retentionDays: number;
}

export interface McpIdempotencyStore {
  run<T extends Record<string, unknown>>(
    input: McpIdempotencyInput,
    handler: () => Promise<T>,
  ): Promise<T>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(request: unknown) {
  return crypto.createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function advisoryLockName(input: McpIdempotencyInput) {
  const digest = crypto
    .createHash("sha256")
    .update(`${input.operation}\0${input.userId}\0${input.key}`)
    .digest("hex");
  return `mcp-idem:${digest.slice(0, 48)}`;
}

function taskIdOf(result: Record<string, unknown>) {
  const taskId = result.task_id;
  if (typeof taskId !== "string") {
    throw new Error("幂等写操作没有返回 task_id。");
  }
  return taskId;
}

export const databaseMcpIdempotencyStore: McpIdempotencyStore = {
  async run<T extends Record<string, unknown>>(
    input: McpIdempotencyInput,
    handler: () => Promise<T>,
  ) {
    if (!input.key) return handler();
    const started = process.hrtime.bigint();
    const hash = requestHash(input.request);
    const lockName = advisoryLockName(input);
    const connection = await pool.getConnection();
    let acquired = false;
    try {
      const [lockRows] = await connection.query<
        Array<RowDataPacket & { acquired: number | null }>
      >("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
      acquired = lockRows[0]?.acquired === 1;
      if (!acquired) {
        throw new ApiV1Error(
          "conflict",
          "相同幂等键的请求仍在处理中，请稍后重试。",
          409,
        );
      }
      auditLog("mcp_idempotency_lock_acquired", {
        tool_name: input.operation,
        user_id: input.userId,
        idempotency_key: input.key,
        wait_ms: elapsedMilliseconds(started),
      });

      await db
        .delete(idempotencyRequests)
        .where(
          and(
            eq(idempotencyRequests.operation, input.operation),
            eq(idempotencyRequests.userScope, input.userId),
            eq(idempotencyRequests.idempotencyKey, input.key),
            lte(idempotencyRequests.expiresAt, new Date()),
          ),
        );
      const [existing] = await db
        .select()
        .from(idempotencyRequests)
        .where(
          and(
            eq(idempotencyRequests.operation, input.operation),
            eq(idempotencyRequests.userScope, input.userId),
            eq(idempotencyRequests.idempotencyKey, input.key),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ApiV1Error(
            "conflict",
            "该幂等键已用于不同参数的请求，请更换 idempotency_key。",
            409,
          );
        }
        if (!existing.responseBody) {
          throw new ApiV1Error(
            "conflict",
            "该幂等请求尚未保存响应，请稍后重试。",
            409,
          );
        }
        auditLog("mcp_idempotency_replayed", {
          tool_name: input.operation,
          user_id: input.userId,
          idempotency_key: input.key,
          task_id: existing.taskId,
        });
        return existing.responseBody as T;
      }

      const result = await handler();
      const now = new Date();
      await db.insert(idempotencyRequests).values({
        id: crypto.randomUUID(),
        operation: input.operation,
        userScope: input.userId,
        idempotencyKey: input.key,
        requestHash: hash,
        taskId: taskIdOf(result),
        responseStatus: 200,
        responseBody: result,
        createdAt: now,
        expiresAt: new Date(
          now.getTime() + input.retentionDays * 24 * 60 * 60 * 1_000,
        ),
      });
      return result;
    } finally {
      if (acquired) {
        await connection
          .query("SELECT RELEASE_LOCK(?)", [lockName])
          .catch(() => undefined);
      }
      connection.release();
    }
  },
};
