import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const runtimeDir = path.resolve(process.env.RUNTIME_DIR || ".run");
const service = process.env.LOG_SERVICE || "application";
const retentionDays = Number(process.env.LOG_RETENTION_DAYS || 7);
const cleanupIntervalSeconds = Number(
  process.env.LOG_CLEANUP_INTERVAL_SECONDS || 3600,
);
const logTimeZone = process.env.LOG_TIME_ZONE || "Asia/Shanghai";

if (!/^[a-z][a-z0-9-]*$/.test(service)) {
  throw new Error("LOG_SERVICE 必须是小写字母、数字或连字符。");
}
if (!Number.isInteger(retentionDays) || retentionDays < 1) {
  throw new Error("LOG_RETENTION_DAYS 必须是正整数。");
}
if (!Number.isInteger(cleanupIntervalSeconds) || cleanupIntervalSeconds < 60) {
  throw new Error("LOG_CLEANUP_INTERVAL_SECONDS 必须是不小于60的整数。");
}
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: logTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

await mkdir(runtimeDir, { recursive: true });

let currentDate = "";
let stream;
// stdin may be a process-substitution pipe whose producer has not emitted yet.
// Keep the sink alive until EOF instead of allowing Node to exit between startup logs.
const stdinKeepAlive = setInterval(() => undefined, 60_000);

function dateKey(now = new Date()) {
  return dateFormatter.format(now);
}

function redactText(value) {
  return value
    .replace(/([?&]X-Amz-[^=\s]+)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(mysql(?:2)?:\/\/)([^@\s]+)@/gi, "$1[REDACTED]@")
    .replace(
      /((?:password|secret|authorization|cookie|access[_-]?key|api[_-]?key|database[_-]?url)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}

function sensitiveKey(key) {
  return /^(?:authorization|cookie|password|secret|token|database_url)$/i.test(key)
    || /(?:access|api|secret)[_-]?key/i.test(key);
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

async function updateCurrentLink(fileName) {
  const linkPath = path.join(runtimeDir, `${service}.log`);
  try {
    const existing = await lstat(linkPath);
    if (existing.isSymbolicLink()) await unlink(linkPath);
    else {
      await rename(
        linkPath,
        path.join(runtimeDir, `${service}-${dateKey()}-${Date.now()}.log`),
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await symlink(fileName, linkPath);
  } catch (error) {
    // 多个 worker 共用同一按日日志时会各自启动一个 sink。它们可能同时
    // 完成 lstat/unlink，随后只有一个 symlink 成功；其余实例继续追加同一
    // 文件即可，不能因 EEXIST 退出并让 worker 的 stdout 管道断开。
    if (error?.code !== "EEXIST") throw error;
  }
}

async function output(now = new Date()) {
  const nextDate = dateKey(now);
  if (stream && currentDate === nextDate) return stream;
  if (stream) await new Promise((resolve) => stream.end(resolve));
  currentDate = nextDate;
  const fileName = `${service}-${currentDate}.log`;
  stream = createWriteStream(path.join(runtimeDir, fileName), {
    flags: "a",
    encoding: "utf8",
    mode: 0o600,
  });
  await updateCurrentLink(fileName);
  return stream;
}

async function cleanExpiredLogs() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const names = await readdir(runtimeDir);
  await Promise.all(
    names
      .filter((name) =>
        /^[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/.test(name),
      )
      .map(async (name) => {
        try {
          const filePath = path.join(runtimeDir, name);
          const metadata = await stat(filePath);
          if (metadata.mtimeMs < cutoff && name !== `${service}-${currentDate}.log`) {
            await unlink(filePath);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }),
  );
}

async function writeLine(line) {
  const now = new Date();
  let record;
  try {
    const parsed = sanitizeValue(JSON.parse(line));
    record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed, logged_at: now.toISOString(), service }
        : { logged_at: now.toISOString(), service, message: parsed };
  } catch {
    record = { logged_at: now.toISOString(), service, message: redactText(line) };
  }
  const destination = await output(now);
  destination.write(`${JSON.stringify(record)}\n`);
}

await cleanExpiredLogs();
const cleanupTimer = setInterval(() => {
  void cleanExpiredLogs().catch((error) => {
    void writeLine(`log cleanup failed: ${String(error)}`);
  });
}, cleanupIntervalSeconds * 1000);
cleanupTimer.unref();

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) await writeLine(line);

clearInterval(cleanupTimer);
clearInterval(stdinKeepAlive);
if (stream) await new Promise((resolve) => stream.end(resolve));
