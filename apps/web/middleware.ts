import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

/**
 * Cookie-PRESENCE gate for AUTH_MODE=firebase — nothing more. This runs on the
 * edge runtime, so no crypto and no Admin SDK here; the cookie is actually
 * verified server-side in src/server/auth.ts on every request. A forged cookie
 * gets past this redirect and then resolves to a signed-out user there.
 */
export function middleware(req: NextRequest): NextResponse {
  if (process.env.AUTH_MODE !== "firebase") return NextResponse.next();

  const { pathname } = req.nextUrl;
  const isPublic = pathname === "/login" || pathname.startsWith("/api/auth/");
  if (isPublic || req.cookies.has(SESSION_COOKIE_NAME)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

/** Everything except Next internals and static assets (paths with a dot). */
export const config = {
  matcher: ["/((?!_next/|.*\\..*).*)"],
};
