import assert from "node:assert/strict";
import test from "node:test";
import { databasePoolConnectionOptions } from "../src/database/database.service";

test("database pool reaps idle connections before MySQL can reuse stale sockets", () => {
  for (const poolSize of [1, 5, 20]) {
    const options = databasePoolConnectionOptions(poolSize);
    assert.ok(options.maxIdle < poolSize);
    assert.equal(options.idleTimeout, 60_000);
    assert.equal(options.enableKeepAlive, true);
    assert.equal(options.keepAliveInitialDelay, 0);
  }
});
