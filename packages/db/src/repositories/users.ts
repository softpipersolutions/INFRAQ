import type { UserRole } from "@pebble/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { users } from "../schema";

export interface AppUser {
  firebaseUid: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
}

/** The identity used when AUTH_MODE=dev — a full admin so every screen works. */
export const DEV_USER: AppUser = {
  firebaseUid: "dev-admin",
  email: "dev@greenberg.local",
  displayName: "Dev Admin",
  role: "admin",
  active: true,
};

export async function getUser(db: Db, firebaseUid: string): Promise<AppUser | null> {
  const rows = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid)).limit(1);
  const r = rows[0];
  return r
    ? {
        firebaseUid: r.firebaseUid,
        email: r.email,
        displayName: r.displayName,
        role: r.role,
        active: r.active,
      }
    : null;
}

export async function upsertUser(db: Db, user: AppUser): Promise<void> {
  await db
    .insert(users)
    .values(user)
    .onConflictDoUpdate({
      target: users.firebaseUid,
      set: { email: user.email, displayName: user.displayName, role: user.role, active: user.active },
    });
}

/** Idempotently ensure the dev admin exists (called on boot in dev mode). */
export async function ensureDevUser(db: Db): Promise<AppUser> {
  await upsertUser(db, DEV_USER);
  return DEV_USER;
}
