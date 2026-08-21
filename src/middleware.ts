import { NextRequest, NextResponse } from "next/server";
import {
  isProtectedWebUiPath,
  normalizeBasePath,
  readWebUiLockConfig,
  safeWebUiReturnPath,
  stripAppBasePath,
  verifyWebUiSession,
  WEBUI_LOCK_COOKIE_NAME,
} from "@/server/auth/webui-lock";

export async function middleware(request: NextRequest) {
  let config;
  try {
    config = readWebUiLockConfig();
  } catch {
    return new NextResponse("WebUI lock configuration is invalid.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  if (!config.enabled || !config.key) return NextResponse.next();

  const internalPath = stripAppBasePath(request.nextUrl.pathname);
  // `/api/**` is deliberately excluded here. The public business API compatibility
  // facade must never inherit the page lock; `/api/v1/openapi` authenticates itself.
  if (
    internalPath === "/lock" ||
    internalPath.startsWith("/api/") ||
    internalPath === "/api" ||
    internalPath.startsWith("/_next/") ||
    !isProtectedWebUiPath(internalPath)
  ) {
    return NextResponse.next();
  }

  const session = request.cookies.get(WEBUI_LOCK_COOKIE_NAME)?.value;
  if (await verifyWebUiSession(session, config.key)) {
    const response = NextResponse.next();
    response.headers.set("cache-control", "private, no-store");
    return response;
  }

  const lockUrl = request.nextUrl.clone();
  lockUrl.pathname = `${normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH)}/lock`;
  lockUrl.search = "";
  const returnPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  lockUrl.searchParams.set("next", safeWebUiReturnPath(returnPath));
  return NextResponse.redirect(lockUrl, 302);
}

export const config = {
  // Keep this broad because the deployed basePath is rewritten before route handling.
  // Classification above strips that prefix and explicitly preserves every API route.
  matcher: ["/:path*"],
};
