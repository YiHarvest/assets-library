import { vi } from "vitest";

// 单元测试不向开发数据库写入监控数据；专用 MySQL 测试显式解除此 mock。
vi.mock("@/server/observability/store", () => ({
  startCall: vi.fn(async () => undefined),
  finishCall: vi.fn(async () => undefined),
  insertCallLog: vi.fn(async () => undefined),
  insertTaskLog: vi.fn(async () => undefined),
  taskCallContext: vi.fn(async () => undefined),
  jobCallOutcome: vi.fn(async () => undefined),
  deleteExpiredCalls: vi.fn(async () => undefined),
}));
