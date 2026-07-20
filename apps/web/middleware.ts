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
  const isPublic =
    pathname === "/" || pathname === "/login" || pathname.startsWith("/api/auth/");
  const hasSession = req.cookies.has(SESSION_COOKIE_NAME);

  // Signed-in users hitting the public landing get sent straight into chat
  // (Phase C.5 chat overhaul WP3 — chat-first shell).
  if (hasSession && pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isPublic || hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

/** Everything except Next internals and static assets (paths with a dot). */
export const config = {
  matcher: ["/((?!_next/|.*\\..*).*)"],
};
