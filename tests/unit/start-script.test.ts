import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function start({ cached = false, old = true, port }: { cached?: boolean; old?: boolean; port?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "asset-start-"));
  directories.push(root);
  for (const directory of ["scripts", "bin", "cached"]) mkdirSync(join(root, directory));
  const script = readFileSync("scripts/start.sh", "utf8")
    .replace("/tmp/node-v22.20.0-linux-x64/bin", join(root, "cached"));
  writeFileSync(join(root, "scripts/start.sh"), script);
  writeFileSync(join(root, ".env"), 'APP_MODE=prd\nPORT=8765\nAPI_INTERNAL_ORIGIN="http://localhost:8765"\nWEB_LISTEN_HOST=localhost\nSCENE_DETECT_ENABLED=false\n');
  const executable = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  executable("uname", "printf 'Linux\\n'");
  if (old) executable("node", `case "$1" in
    -p) printf '12\\n' ;;
    --version) printf 'v12.22.9\\n' ;;
    *) printf "Cannot find module 'node:util'\\n" >&2; exit 1 ;;
  esac`);
  else symlinkSync(process.execPath, join(root, "bin/node"));
  if (cached) symlinkSync(process.execPath, join(root, "cached/node"));
  // Stop at the first preflight: never start services or access a database.
  executable("pnpm", 'printf "PREFLIGHT:%s:%s:%s\\n" "$PORT" "$APP_MODE" "$API_INTERNAL_ORIGIN"; exit 77');
  return spawnSync("/bin/bash", [join(root, "scripts/start.sh")], {
    env: { NODE_ENV: "test", PATH: `${join(root, "bin")}:/usr/bin:/bin`, ...(port ? { PORT: port } : {}) },
    encoding: "utf8", timeout: 5000,
  });
}

it("selects cached Node before loading .env when PATH contains Node 12", () => {
  const result = start({ cached: true });
  expect(result.status).toBe(77);
  expect(result.stdout).toContain("PREFLIGHT:8765:prd:http://localhost:8765");
  expect(result.stderr).toBe("");
});

it("rejects old Node before reporting misleading missing environment variables", () => {
  const result = start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Node.js 22+");
  expect(result.stderr).not.toMatch(/node:util|缺少必需环境变量/);
  expect(result.stdout).not.toContain("PREFLIGHT");
});

it("uses modern PATH Node and preserves explicit environment overrides", () => {
  const result = start({ old: false, port: "9876" });
  expect(result.status).toBe(77);
  expect(result.stdout).toContain("PREFLIGHT:9876:prd:http://localhost:8765");
  expect(result.stderr).toBe("");
});
