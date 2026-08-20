import { NextResponse } from "next/server";
import {
  createWebUiSession,
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
const attempts = new Map<string, { count: number; resetAt: number }>();

export async function POST(request: Request) {
  let config;
  try {
    config = readWebUiLockConfig();
  } catch {
    return unavailable();
  }

  if (!config.enabled || !config.key) {
    return NextResponse.redirect(
      new URL(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`, request.url),
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
  if (isRateLimited(client, now)) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: { "retry-after": "300", "cache-control": "no-store" },
    });
  }

  const form = new URLSearchParams(body);
  const returnPath = safeWebUiReturnPath(form.get("next"));
  if (!webUiLockKeyMatches(form.get("key"), config.key)) {
    recordFailure(client, now);
    const lockUrl = new URL(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/lock`, request.url);
    lockUrl.searchParams.set("error", "invalid");
    lockUrl.searchParams.set("next", returnPath);
    return NextResponse.redirect(lockUrl, 303);
  }

  attempts.delete(client);
  const session = await createWebUiSession(config.key, now);
  const response = NextResponse.redirect(new URL(returnPath, request.url), 303);
  response.cookies.set(WEBUI_LOCK_COOKIE_NAME, session, {
    httpOnly: true,
    secure: config.appMode === "prd",
    sameSite: "lax",
    maxAge: WEBUI_LOCK_SESSION_SECONDS,
    path: webUiCookiePath(),
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

function clientAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(client: string, now: number) {
  const entry = attempts.get(client);
  if (!entry || entry.resetAt <= now) {
    attempts.delete(client);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(client: string, now: number) {
  const entry = attempts.get(client);
  if (!entry || entry.resetAt <= now) {
    attempts.set(client, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function unavailable() {
  return new NextResponse("WebUI lock configuration is invalid.", {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}
