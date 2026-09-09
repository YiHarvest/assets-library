import { createHash } from "node:crypto";

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable across object key insertion order, locale and process. Array order is meaningful. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function fingerprint(value: unknown) { return hashText(canonicalJson(value)); }
export function compareText(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
export function normalizeSearchText(text: string) { return text.normalize("NFC").replace(/\s+/gu, " ").trim(); }
