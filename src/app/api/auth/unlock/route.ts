import { NextResponse } from "next/server";
import {
  createWebUiSession,
  normalizeBasePath,
  readWebUiLockConfig,
  safeWebUiReturnPath,
  webUiCookiePath,
  WEBUI_LOCK_COOKIE_NAME,
  WEBUI_LOCK_SESSION_SECONDS,
} from "@/server/auth/webui-lock";
import { webUiLockKeyMatches } from "@/server/auth/webui-lock-node";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1_000;
const rateLimiter = createInMemoryRateLimiter(MAX_ATTEMPTS, ATTEMPT_WINDOW_MS);

export async function POST(request: Request) {
  let config;
  try {
    config = readWebUiLockConfig();
  } catch {
    return unavailable();
  }

  if (!config.enabled || !config.key) {
    return NextResponse.redirect(
      new URL(`${normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH)}/`, request.url),
      303,
    );
  }

  const contentType = request.headers.get("content-type") || "";
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return new NextResponse("Unsupported Media Type", { status: 415 });
  }
  if (contentLength > MAX_BODY_BYTES) {
    return new NextResponse("Payload Too Large", { status: 413 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return new NextResponse("Payload Too Large", { status: 413 });
  }

  const client = clientAddress(request);
  const now = Date.now();
  if (rateLimiter.isRateLimited(client, now)) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: { "retry-after": "300", "cache-control": "no-store" },
    });
  }

  const form = new URLSearchParams(body);
  const returnPath = safeWebUiReturnPath(form.get("next"));
  const origin = resolveOrigin(request);
  if (!webUiLockKeyMatches(form.get("key"), config.key)) {
    rateLimiter.recordFailure(client, now);
    const lockUrl = new URL(
      `${normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH)}/lock`,
      origin.baseUrl,
    );
    lockUrl.searchParams.set("error", "invalid");
    lockUrl.searchParams.set("next", returnPath);
    return NextResponse.redirect(lockUrl, 303);
  }

  rateLimiter.reset(client);
  const session = await createWebUiSession(config.key, now);
  const redirectUrl = `${origin.baseUrl}${returnPath}`;
  const response = NextResponse.redirect(redirectUrl, 303);
  response.cookies.set(WEBUI_LOCK_COOKIE_NAME, session, {
    httpOnly: true,
    secure: origin.isSecure,
    sameSite: "lax",
    maxAge: WEBUI_LOCK_SESSION_SECONDS,
    path: webUiCookiePath(),
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

function clientAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) return forwarded;
  for (const header of [
    "x-real-ip",
    "cf-connecting-ip",
    "fly-client-ip",
    "x-client-ip",
  ]) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  const host = request.headers.get("host")?.slice(0, 255) || "unknown-host";
  const userAgent =
    request.headers.get("user-agent")?.slice(0, 512) || "unknown-agent";
  return `${host}::${userAgent}`;
}

function resolveOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : requestUrl.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    requestUrl.host;
  try {
    const candidate = new URL(`${protocol}://${host}`);
    if (candidate.pathname !== "/" || candidate.search || candidate.hash) {
      throw new Error("Invalid forwarded origin");
    }
    return {
      baseUrl: candidate.origin,
      isSecure: candidate.protocol === "https:",
    };
  } catch {
    return {
      baseUrl: requestUrl.origin,
      isSecure: requestUrl.protocol === "https:",
    };
  }
}

function createInMemoryRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    isRateLimited(client: string, now: number) {
      const entry = attempts.get(client);
      if (!entry || entry.resetAt <= now) {
        attempts.delete(client);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    recordFailure(client: string, now: number) {
      const entry = attempts.get(client);
      if (!entry || entry.resetAt <= now) {
        attempts.set(client, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    reset(client: string) {
      attempts.delete(client);
    },
  };
}

function unavailable() {
  return new NextResponse("WebUI lock configuration is invalid.", {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}
