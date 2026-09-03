import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../helpers/config";
import {
  assertDedicatedIntegrationDatabase,
  bindIntegrationDatabaseEnvironment,
  configuredWebUiDatabaseName,
  integrationApplicationTables,
  truncateIntegrationTables,
} from "../helpers/integration-database";

describe("integration database safety", () => {
  it("accepts a dedicated integration database", () => {
    expect(
      assertDedicatedIntegrationDatabase(
        "mysql://tester:secret@localhost/assets_library_test",
        { databaseUrl: "mysql://app:secret@localhost/assets_library_dev_test" },
      ),
    ).toEqual({
      hostname: "localhost",
      port: "3306",
      database: "assets_library_test",
    });
  });

  it("rejects the shared development database before cleanup can run", () => {
    expect(() =>
      assertDedicatedIntegrationDatabase(
        "mysql://tester:secret@localhost/assets_library_dev_test",
        { databaseName: "assets_library_dev_test" },
      ),
    ).toThrow("不得与 WebUI");
  });

  it("rejects an integration-named target shared with the WebUI", () => {
    expect(() =>
      assertDedicatedIntegrationDatabase(
        "mysql://tester:secret@db.example.test:3307/assets_test",
        {
          databaseUrl:
            "mysql://app:other@db.example.test:3307/assets_test",
        },
      ),
    ).toThrow("不得与 WebUI");
  });

  it("rejects a database without the test suffix", () => {
    expect(() =>
      assertDedicatedIntegrationDatabase(
        "mysql://tester:secret@localhost/assets_library",
        { databaseName: "assets_library_dev_test" },
      ),
    ).toThrow("以 _test 结尾");
  });

  it("resolves the effective WebUI database name without reading credentials", () => {
    expect(configuredWebUiDatabaseName({ APP_MODE: "dev" })).toBe(
      "assets_library_dev_test",
    );
    expect(
      configuredWebUiDatabaseName({
        APP_MODE: "dev",
        DEV_DATABASE_NAME: "custom_dev_test",
      }),
    ).toBe("custom_dev_test");
  });

  it("binds the effective dev database to the validated integration target", () => {
    const env: Record<string, string | undefined> = {
      APP_MODE: "dev",
      DATABASE_URL: "mysql://app:secret@localhost/assets_library_dev_test",
      DEV_DATABASE_NAME: "assets_library_dev_test",
    };

    bindIntegrationDatabaseEnvironment(
      "mysql://tester:secret@localhost/assets_library_test",
      env,
    );

    expect(env.DEV_DATABASE_NAME).toBe("assets_library_test");
    expect(loadTestConfig(env).databaseTarget).toEqual({
      hostname: "localhost",
      port: "3306",
      database: "assets_library_test",
    });
  });

  it("keeps all application tables in the cleanup allowlist", () => {
    expect(integrationApplicationTables).not.toContain("assets");
    expect(integrationApplicationTables).toContain("public_assets");
    expect(integrationApplicationTables).toContain("private_assets");
    expect(integrationApplicationTables).toContain("media_objects");
    expect(integrationApplicationTables).toContain("tags");
    expect(integrationApplicationTables).not.toContain("__drizzle_migrations");
  });

  it("restores foreign-key checks and releases the connection after cleanup", async () => {
    const query = vi.fn(async (statement: string) => {
      void statement;
    });
    const release = vi.fn();
    const pool = {
      getConnection: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    await truncateIntegrationTables(pool);

    expect(query.mock.calls[0]?.[0]).toBe("SET FOREIGN_KEY_CHECKS = 0");
    expect(query).toHaveBeenCalledWith("TRUNCATE TABLE `public_assets`");
    expect(query.mock.calls.at(-1)?.[0]).toBe("SET FOREIGN_KEY_CHECKS = 1");
    expect(release).toHaveBeenCalledOnce();
  });

  it("still restores the connection when truncation fails", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "TRUNCATE TABLE `public_assets`") {
        throw new Error("cleanup failed");
      }
    });
    const release = vi.fn();
    const pool = {
      getConnection: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    await expect(truncateIntegrationTables(pool)).rejects.toThrow(
      "cleanup failed",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("SET FOREIGN_KEY_CHECKS = 1");
    expect(release).toHaveBeenCalledOnce();
  });
});
