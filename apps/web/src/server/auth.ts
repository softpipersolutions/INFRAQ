import "server-only";

import {
  DEV_USER,
  ensureDevUser,
  getUser,
  isEmailInDbAllowlist,
  schema,
  upsertUser,
  type AppUser,
  type Db,
} from "@pebble/db";
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
 * The subset of process.env the allowlist reads; injectable so it is
 * unit-testable. The index signature keeps it assignable from NodeJS.ProcessEnv
 * (whose only declared member is a `string | undefined` index).
 */
export type AllowlistEnv = {
  PEBBLE_ALLOWED_EMAILS?: string;
  PEBBLE_ALLOWED_DOMAIN?: string;
  [key: string]: string | undefined;
};

/**
 * The DEPLOY-BAKED allowlist: PEBBLE_ALLOWED_EMAILS (comma-separated) and/or
 * PEBBLE_ALLOWED_DOMAIN, parsed into a normalized shape. Exposed so the admin
 * Access page can show the env base list read-only ("configured at deploy").
 */
export function parseEnvAllowlist(env: AllowlistEnv = process.env): {
  emails: string[];
  domain: string | null;
} {
  const emails = (env.PEBBLE_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const domain = env.PEBBLE_ALLOWED_DOMAIN?.trim().toLowerCase() || null;
  return { emails, domain };
}

/**
 * ENV-ONLY allowlist gate. True when the email is in PEBBLE_ALLOWED_EMAILS or
 * under PEBBLE_ALLOWED_DOMAIN. This is only HALF of the effective check — see
 * isEmailAllowedForApp for the union with the DB-managed allowlist.
 */
export function isEmailAllowedByEnv(email: string, env: AllowlistEnv = process.env): boolean {
  const { emails, domain } = parseEnvAllowlist(env);
  const candidate = email.trim().toLowerCase();
  if (emails.includes(candidate)) return true;
  if (domain && candidate.endsWith(`@${domain}`)) return true;
  return false;
}

/**
 * The EFFECTIVE allowlist gate for firebase mode: the env allowlist UNION the
 * DB-managed allowed_emails (an admin can approve new accounts at runtime with
 * no redeploy). FAIL-CLOSED is preserved — with an empty env allowlist AND an
 * empty (or fully-deactivated) table, every login is denied. A deactivated DB
 * row fails the offender closed on their next request, exactly like removing
 * them from the env list.
 */
export async function isEmailAllowedForApp(
  db: Db,
  email: string,
  env: AllowlistEnv = process.env,
): Promise<boolean> {
  if (isEmailAllowedByEnv(email, env)) return true;
  return isEmailInDbAllowlist(db, email);
}

/**
 * Bootstrap check: does any active, real (non-dev) admin exist? Until one
 * does, the first allowlisted sign-in is provisioned/promoted as admin —
 * otherwise a fresh deployment has working auth but nobody who can reach
 * /admin/users to grant roles. The allowlist is the security boundary here;
 * the users table is small, so a full read + JS filter matches the codebase's
 * list-query style.
 */
async function hasRealAdmin(db: Db): Promise<boolean> {
  const rows = await db.select().from(schema.users);
  return rows.some(
    (u) => u.role === "admin" && u.active && u.firebaseUid !== DEV_USER.firebaseUid,
  );
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
  // Re-checked on EVERY request (union of env + DB allowlist): a user whose DB
  // allowlist entry was deactivated fails closed here on their next request.
  if (!email || !(await isEmailAllowedForApp(db, email))) return null;

  const existing = await getUser(db, decoded.uid);
  if (existing) {
    if (!existing.active) return null;
    // Bootstrap: an allowlisted account signed in while the deployment still
    // has no real admin (e.g. it was provisioned as estimator before this
    // rule existed) — promote it so role management is reachable at all.
    if (existing.role !== "admin" && !(await hasRealAdmin(db))) {
      const promoted: AppUser = { ...existing, role: "admin" };
      await upsertUser(db, promoted);
      return promoted;
    }
    return existing;
  }

  // First login of an allowlisted account: least privilege once a real admin
  // exists (promotion happens via /admin/users); the very first account
  // becomes admin so the deployment is administrable.
  const displayName = typeof decoded.name === "string" && decoded.name ? decoded.name : email;
  const user: AppUser = {
    firebaseUid: decoded.uid,
    email,
    displayName,
    role: (await hasRealAdmin(db)) ? "estimator" : "admin",
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
