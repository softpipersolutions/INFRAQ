import "server-only";

import { ensureDevUser, getUser, upsertUser, type AppUser, type Db } from "@pebble/db";
import { cookies } from "next/headers";
import { cache } from "react";
import { SESSION_COOKIE_NAME } from "../lib/session";
import { getDb } from "./db";
import { isFirebaseConfigured, verifySessionCookie } from "./firebase-admin";

/**
 * Authentication for the web app.
 *
 * AUTH_MODE=dev (the default, and the only mode that needs zero cloud
 * credentials) returns the dev admin so every screen works locally on PGlite.
 *
 * AUTH_MODE=firebase verifies the "__pebble_session" cookie via the Admin SDK
 * (lazy import — never loaded in dev), enforces the sign-in allowlist and
 * resolves/provisions the user row. Everything here FAILS CLOSED: no cookie,
 * a bad cookie, a non-allowlisted email or a deactivated user all yield null
 * (signed out) — never a fallback identity.
 */

/**
 * Allowlist gate for firebase mode: PEBBLE_ALLOWED_EMAILS (comma-separated)
 * and/or PEBBLE_ALLOWED_DOMAIN. With NEITHER set, every login is denied —
 * a misconfigured deployment must not accept arbitrary Google accounts.
 */
export function isEmailAllowed(email: string): boolean {
  const allowedEmails = (process.env.PEBBLE_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const allowedDomain = process.env.PEBBLE_ALLOWED_DOMAIN?.trim().toLowerCase();

  const candidate = email.trim().toLowerCase();
  if (allowedEmails.includes(candidate)) return true;
  if (allowedDomain && candidate.endsWith(`@${allowedDomain}`)) return true;
  return false;
}

async function firebaseUser(db: Db): Promise<AppUser | null> {
  // Test escape hatch (kept from the placeholder): act as a stored user by uid
  // without a cookie. Only honoured in firebase mode; never set in production.
  const testUid = process.env.PEBBLE_SESSION_UID;
  if (testUid) return getUser(db, testUid);

  if (!isFirebaseConfigured()) return null;

  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return null;

  let decoded;
  try {
    decoded = await verifySessionCookie(cookie);
  } catch {
    // Expired, revoked or forged cookie — treat as signed out.
    return null;
  }

  const email = typeof decoded.email === "string" ? decoded.email : null;
  if (!email || !isEmailAllowed(email)) return null;

  const existing = await getUser(db, decoded.uid);
  if (existing) return existing.active ? existing : null;

  // First login of an allowlisted account: provision with least privilege.
  // Admins promote via /admin/users.
  const displayName = typeof decoded.name === "string" && decoded.name ? decoded.name : email;
  const user: AppUser = {
    firebaseUid: decoded.uid,
    email,
    displayName,
    role: "estimator",
    active: true,
  };
  await upsertUser(db, user);
  return user;
}

/**
 * Resolve the current user, memoized per request via React cache() so the
 * session cookie is verified at most once per request. Null means signed out
 * (only possible in firebase mode).
 */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const mode = process.env.AUTH_MODE ?? "dev";
  const { db } = await getDb();

  if (mode !== "firebase") {
    return ensureDevUser(db);
  }
  return firebaseUser(db);
});

export type { AppUser };
