const WEBUI_LOCK_PURPOSE = "assets-library:webui-session:v1";

export const WEBUI_LOCK_COOKIE_NAME = "assets_library_webui_session";
export const WEBUI_LOCK_SESSION_SECONDS = 12 * 60 * 60;

export interface WebUiLockConfig {
  appMode: "dev" | "prd";
  enabled: boolean;
  key?: string;
}

type WebUiLockEnvironment = Record<string, string | undefined>;

export function readWebUiLockConfig(
  env: WebUiLockEnvironment = process.env,
): WebUiLockConfig {
  const appMode = env.APP_MODE?.trim() || "dev";
  if (appMode !== "dev" && appMode !== "prd") {
    throw new Error("APP_MODE 必须是 dev 或 prd。");
  }

  const key = env.WEBUI_LOCK_KEY?.trim() || undefined;
  if (appMode === "prd" && !key) {
    throw new Error("生产模式必须配置 WEBUI_LOCK_KEY，页面锁拒绝开放启动。");
  }
  if (key && key.length < 32) {
    throw new Error("WEBUI_LOCK_KEY 至少需要 32 个字符。");
  }

  return { appMode, enabled: Boolean(key), key };
}

export function webUiCookiePath(env: WebUiLockEnvironment = process.env) {
  return normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH) || "/";
}

export function stripAppBasePath(
  pathname: string,
  env: WebUiLockEnvironment = process.env,
) {
  const basePath = normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH);
  if (!basePath) return pathname || "/";
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname || "/";
}

export function isProtectedWebUiPath(pathname: string) {
  const normalized = normalizePathname(pathname);
  if (
    normalized === "/" ||
    normalized === "/upload" ||
    normalized === "/docs" ||
    normalized === "/api-docs"
  ) {
    return true;
  }
  return /^\/assets\/[^/]+$/.test(normalized);
}

export function safeWebUiReturnPath(
  value: string | null | undefined,
  env: WebUiLockEnvironment = process.env,
) {
  const basePath = normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH);
  const fallback = `${basePath}/` || "/";
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;

  let url: URL;
  try {
    url = new URL(value, "http://webui.local");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://webui.local") return fallback;
  const internalPath = stripAppBasePath(url.pathname, env);
  if (!isProtectedWebUiPath(internalPath)) return fallback;

  // A session cookie is intentionally scoped to basePath. Normalize legacy or
  // hand-authored return paths such as `/` and `/upload` into that same scope,
  // otherwise a successful unlock immediately loses its cookie on redirect.
  const alreadyPrefixed =
    !basePath ||
    url.pathname === basePath ||
    url.pathname.startsWith(`${basePath}/`);
  const pathname = alreadyPrefixed
    ? url.pathname
    : internalPath === "/"
      ? `${basePath}/`
      : `${basePath}${internalPath}`;
  return `${pathname}${url.search}`;
}

export function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function createWebUiSession(key: string, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + WEBUI_LOCK_SESSION_SECONDS;
  const nonce = crypto.getRandomValues(new Uint8Array(18));
  const payload = `v1.${expiresAt}.${encodeBase64Url(nonce)}`;
  const signature = await sign(payload, key);
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function verifyWebUiSession(
  value: string | null | undefined,
  key: string,
  now = Date.now(),
) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) {
    return false;
  }

  try {
    const signingKey = await deriveSigningKey(key);
    return crypto.subtle.verify(
      "HMAC",
      signingKey,
      decodeBase64Url(parts[3]),
      new TextEncoder().encode(parts.slice(0, 3).join(".")),
    );
  } catch {
    return false;
  }
}

export function normalizeBasePath(value: string | undefined) {
  const segments = value?.trim().split("/").filter(Boolean) ?? [];
  return segments.length ? `/${segments.join("/")}` : "";
}

function normalizePathname(value: string) {
  if (value === "/") return value;
  return value.replace(/\/+$/, "") || "/";
}

async function sign(payload: string, key: string) {
  const signingKey = await deriveSigningKey(key);
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      signingKey,
      new TextEncoder().encode(payload),
    ),
  );
}

async function deriveSigningKey(key: string) {
  const sourceKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    sourceKey,
    new TextEncoder().encode(WEBUI_LOCK_PURPOSE),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
