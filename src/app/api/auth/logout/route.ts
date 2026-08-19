import { NextResponse } from "next/server";
import {
  webUiCookiePath,
  WEBUI_LOCK_COOKIE_NAME,
} from "@/server/auth/webui-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const lockUrl = new URL(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/lock`, request.url);
  const response = NextResponse.redirect(lockUrl, 303);
  response.cookies.set(WEBUI_LOCK_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.APP_MODE === "prd",
    sameSite: "lax",
    maxAge: 0,
    path: webUiCookiePath(),
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
