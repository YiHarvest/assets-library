import { describe, expect, it, vi } from "vitest";
import {
  isDeadlockError,
  withDeadlockRetry,
} from "@/server/db/retry";

describe("db deadlock retry", () => {
  it("detects 1213 and 1205 through nested cause chains", () => {
    const nested = new Error("wrapped", {
      cause: new Error("inner", {
        cause: { errno: 1213, code: "ER_LOCK_DEADLOCK" },
      }),
    });
    expect(isDeadlockError(nested)).toBe(true);
    expect(
      isDeadlockError(new Error("x", { cause: { errno: 1205 } })),
    ).toBe(true);
    expect(isDeadlockError({ code: "ER_LOCK_WAIT_TIMEOUT" })).toBe(true);
    expect(
      isDeadlockError(new Error("plain", { cause: { errno: 1062 } })),
    ).toBe(false);
    expect(isDeadlockError(null)).toBe(false);
    expect(isDeadlockError("boom")).toBe(false);
  });

  it("retries the whole operation on deadlock and succeeds", async () => {
    const operation = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce({ errno: 1213 })
      .mockRejectedValueOnce(new Error("wrapped", { cause: { errno: 1205 } }))
      .mockResolvedValueOnce(42);
    const onRetry = vi.fn();

    await expect(
      withDeadlockRetry(operation, { attempts: 3, onRetry }),
    ).resolves.toBe(42);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-deadlock errors immediately", async () => {
    const operation = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("not a deadlock"));

    await expect(
      withDeadlockRetry(operation, { attempts: 3 }),
    ).rejects.toThrow("not a deadlock");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error when retries are exhausted", async () => {
    const operation = vi
      .fn<() => Promise<number>>()
      .mockRejectedValue({ errno: 1213 });

    await expect(
      withDeadlockRetry(operation, { attempts: 2, backoffMs: 1 }),
    ).rejects.toEqual({ errno: 1213 });
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
