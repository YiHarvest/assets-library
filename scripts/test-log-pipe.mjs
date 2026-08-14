import { openSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "assets-log-pipe-"));
const forbidden = [
  "demo-token",
  "cookie-value",
  "db-password",
  "access-value",
  "signature-value",
];
const samples = [
  JSON.stringify({ authorization: "Bearer demo-token", cookie: "cookie-value" }),
  JSON.stringify({ nested: { DATABASE_URL: "mysql://user:db-password@db/app" } }),
  "authorization: Bearer demo-token",
  "mysql://user:db-password@127.0.0.1/app",
  "https://zos.example/file?X-Amz-Credential=access-value&X-Amz-Signature=signature-value",
];
const inputPath = path.join(runtimeDir, "input.txt");
await writeFile(inputPath, `${samples.join("\n")}\n`, { mode: 0o600 });
async function runPipe(service, sourcePath) {
  const child = spawn(process.execPath, [path.resolve("scripts/log-pipe.mjs")], {
    env: {
      ...process.env,
      RUNTIME_DIR: runtimeDir,
      LOG_SERVICE: service,
      LOG_RETENTION_DAYS: "7",
      LOG_CLEANUP_INTERVAL_SECONDS: "3600",
    },
    stdio: [openSync(sourcePath, "r"), "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`log-pipe exited with ${exitCode}: ${stderr}`);
}

await runPipe("security-test", inputPath);

const output = await readFile(path.join(runtimeDir, "security-test.log"), "utf8");
for (const secret of forbidden) {
  if (output.includes(secret)) throw new Error(`sensitive value leaked: ${secret}`);
}
if (!output.includes("[REDACTED]")) throw new Error("redaction marker missing");

// 多个worker会并发启动同名日志sink；软链接更新和append都必须无竞争失败。
const concurrentInputs = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
  const sourcePath = path.join(runtimeDir, `concurrent-${index}.txt`);
  await writeFile(sourcePath, `concurrent-worker-${index}\n`, { mode: 0o600 });
  return sourcePath;
}));
await Promise.all(concurrentInputs.map((sourcePath) => runPipe("worker", sourcePath)));
const concurrentOutput = await readFile(path.join(runtimeDir, "worker.log"), "utf8");
for (let index = 0; index < concurrentInputs.length; index += 1) {
  if (!concurrentOutput.includes(`concurrent-worker-${index}`)) {
    throw new Error(`concurrent worker log missing: ${index}`);
  }
}

process.stdout.write("log-pipe redaction and concurrency: ok\n");
