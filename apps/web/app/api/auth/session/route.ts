import { recordAccessRequest } from "@pebble/db";
import { NextResponse } from "next/server";
import { isEmailAllowedForApp } from "@/server/auth";
import { getDb } from "@/server/db";
import { createSessionCookie, isFirebaseConfigured, verifyIdToken } from "@/server/firebase-admin";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "@/lib/session";

/** Admin SDK is Node-only; never let this route drift to the edge runtime. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieOptions = {
  httpOnly: true,
  // `secure` only in production so AUTH_MODE=firebase is testable on http://localhost.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;

/**
 * POST {idToken} — verify a fresh Google sign-in, enforce the allowlist, then
 * mint a 14-day Firebase session cookie. The allowlist is ALSO enforced on
 * every request in auth.ts; checking here just gives the login page a clear
 * 403 instead of a silent signed-out loop.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if ((process.env.AUTH_MODE ?? "dev") !== "firebase" || !isFirebaseConfigured()) {
    return NextResponse.json({ error: "Firebase auth is not enabled" }, { status: 503 });
  }

  let idToken: unknown;
  try {
    idToken = ((await req.json()) as { idToken?: unknown }).idToken;
  } catch {
    // fall through to the shape check
  }
  if (typeof idToken !== "string" || idToken.length === 0) {
    return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
  }

  let email: string | null;
  let displayName: string | null;
  try {
    const decoded = await verifyIdToken(idToken);
    email = typeof decoded.email === "string" ? decoded.email : null;
    displayName = typeof decoded.name === "string" && decoded.name ? decoded.name : null;
  } catch {
    return NextResponse.json({ error: "Invalid or expired sign-in token" }, { status: 401 });
  }

  const { db } = await getDb();
  if (!email || !(await isEmailAllowedForApp(db, email))) {
    // Log the denied attempt BEFORE the 403 so an admin can approve it from
    // Admin → Access with no redeploy. Re-attempts bump the counter but never
    // resurrect a DENIED request. (Shape/status unchanged so the login page's
    // AccessDeniedError parsing still works.)
    if (email) await recordAccessRequest(db, { email, displayName });
    return NextResponse.json(
      {
        error:
          "This Google account is not authorised for Pebble yet. Your request has been noted — an admin can approve it from Admin → Access.",
      },
      { status: 403 },
    );
  }

  const sessionCookie = await createSessionCookie(idToken, SESSION_TTL_MS);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, sessionCookie, {
    ...cookieOptions,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}

/** DELETE — sign out by clearing the session cookie. */
export function DELETE(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  return res;
}
