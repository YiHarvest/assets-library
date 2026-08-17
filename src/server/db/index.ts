import { getDatabase } from "./singleton";
import { withDeadlockRetry } from "./retry";

const { pool, db: rawDb } = getDatabase();

/**
 * 所有 `db.transaction` 调用自动带死锁重试：InnoDB 检测到死锁/锁等待超时
 * 后已整体回滚受害者事务，整体重跑是安全的；非死锁错误原样抛出。
 */
export const db = new Proxy(rawDb, {
  get(target, prop) {
    if (prop === "transaction") {
      return (
        callback: Parameters<typeof rawDb.transaction>[0],
        config?: Parameters<typeof rawDb.transaction>[1],
      ) => withDeadlockRetry(() => target.transaction(callback, config));
    }
    return Reflect.get(target, prop);
  },
}) as typeof rawDb;

export { pool };