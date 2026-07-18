import "server-only";

import { ensureDevUser, getUser, type AppUser } from "@pebble/db";
import { getDb } from "./db";

/**
 * Authentication for the web app.
 *
 * AUTH_MODE=dev (the default, and the only mode that needs zero cloud
 * credentials) returns the dev admin so every screen works locally on PGlite.
 * Firebase is a lazy optional import reserved for a later phase — it is never
 * required to run the app.
 */
export async function getCurrentUser(): Promise<AppUser> {
  const mode = process.env.AUTH_MODE ?? "dev";
  const { db } = await getDb();

  if (mode === "dev") {
    return ensureDevUser(db);
  }

  // Firebase-backed auth is deferred; when a session uid is present we resolve
  // the stored user, otherwise we fall back to the dev admin so the app is
  // never left without an actor.
  const uid = process.env.PEBBLE_SESSION_UID;
  if (uid) {
    const user = await getUser(db, uid);
    if (user) return user;
  }
  return ensureDevUser(db);
}

export type { AppUser };
