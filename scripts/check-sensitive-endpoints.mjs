import fs from "node:fs";
import { execFileSync } from "node:child_process";

const trackedAndUnignored = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const ipv4Literal = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g;
const urlWithNumericPort =
  /(?:https?|wss?|mysql|postgres(?:ql)?):\/\/[^\s"'<>]+:\d{2,5}(?=[/\s"'<>]|$)/;
const endpointExample =
  /^([A-Z][A-Z0-9_]*(?:URL|URI|HOST|PORT|ENDPOINT|ORIGIN|BASE_PATH))[ \t]*=[ \t]*([^#\s].*)$/gm;
const dockerWildcard = Array.from({ length: 4 }, () => "0").join(".");

const findings = [];
for (const file of trackedAndUnignored) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  // A gitlink points at a separate repository and must be audited there.
  if (!stat.isFile()) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  const hasForbiddenIpv4 = [...source.matchAll(ipv4Literal)].some(
    (match) => !(file === "Dockerfile" && match[0] === dockerWildcard),
  );
  if (hasForbiddenIpv4) {
    findings.push(`${file}: IPv4 literal`);
  }
  if (urlWithNumericPort.test(source)) {
    findings.push(`${file}: URL with explicit numeric port`);
  }
  if (file.endsWith(".env.example")) {
    for (const match of source.matchAll(endpointExample)) {
      findings.push(`${file}: nonblank endpoint example ${match[1]}`);
    }
  }
}

if (findings.length) {
  console.error("Sensitive endpoint scan failed:");
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Sensitive endpoint scan passed.");
