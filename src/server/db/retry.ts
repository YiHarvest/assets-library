/** MySQL 死锁 / 锁等待超时的 InnoDB 错误码（SQLSTATE 40001 / HY000）。 */
const DEADLOCK_ERRNOS = new Set([1213, 1205]);
const DEADLOCK_CODES = new Set([
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
]);

/**
 * 判断错误是否为 InnoDB 死锁或锁等待超时。
 *
 * drizzle 可能把驱动错误包装在多层 Error.cause 里，这里沿 cause 链逐层
 * 检查 errno（1213/1205）与驱动错误码（ER_LOCK_DEADLOCK/ER_LOCK_WAIT_TIMEOUT）。
 */
export function isDeadlockError(error: unknown): boolean {
  let cursor: unknown = error;
  while (cursor && typeof cursor === "object") {
    const candidate = cursor as { errno?: unknown; code?: unknown };
    if (
      typeof candidate.errno === "number" &&
      DEADLOCK_ERRNOS.has(candidate.errno)
    ) {
      return true;
    }
    if (
      typeof candidate.code === "string" &&
      DEADLOCK_CODES.has(candidate.code)
    ) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export interface DeadlockRetryOptions {
  /** 总尝试次数（含首次），默认 3。 */
  attempts?: number;
  /** 首次重试前的等待毫秒数，默认 50；之后按指数退避。 */
  backoffMs?: number;
  /** 可选日志回调（默认只重试不输出）。 */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * 在死锁或锁等待超时时重试整个操作。
 *
 * InnoDB 检测到死锁后会把受害者事务整体回滚并返回 1213，因此整个操作
 * 重跑是安全的；1205 同理（事务已被回滚）。非死锁错误立即抛出，不会吞错。
 */
export async function withDeadlockRetry<T>(
  operation: () => Promise<T>,
  options: DeadlockRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffMs = Math.max(0, options.backoffMs ?? 50);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isDeadlockError(error) || attempt >= attempts) throw error;
      options.onRetry?.(attempt, error);
      await new Promise((resolve) =>
        setTimeout(resolve, backoffMs * 2 ** (attempt - 1)),
      );
    }
  }
  throw lastError;
}