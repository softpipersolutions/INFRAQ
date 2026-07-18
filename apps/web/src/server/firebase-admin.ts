import "server-only";

import type { App } from "firebase-admin/app";
import type { Auth, DecodedIdToken } from "firebase-admin/auth";

/**
 * Lazy singleton around the Firebase Admin SDK.
 *
 * firebase-admin is a heavy Node-only package and is only needed when
 * AUTH_MODE=firebase, so it is loaded via dynamic import the first time a
 * helper is called — `next build` and dev mode never touch it and require no
 * Firebase env vars. Credentials come from Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS locally, ambient ADC on Cloud Run);
 * FIREBASE_PROJECT_ID / NEXT_PUBLIC_FIREBASE_PROJECT_ID pin the project id.
 */

let authPromise: Promise<Auth> | null = null;

function projectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
}

/** True when enough env is present to even attempt Admin SDK verification. */
export function isFirebaseConfigured(): boolean {
  return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? projectId());
}

async function getAdminAuth(): Promise<Auth> {
  if (!authPromise) {
    authPromise = (async () => {
      const { applicationDefault, getApps, initializeApp } = await import("firebase-admin/app");
      const { getAuth } = await import("firebase-admin/auth");
      const existing = getApps();
      const app: App =
        existing[0] ??
        initializeApp({
          credential: applicationDefault(),
          ...(projectId() ? { projectId: projectId() } : {}),
        });
      return getAuth(app);
    })().catch((err) => {
      // Reset so a transient failure (e.g. missing creds fixed later) retries.
      authPromise = null;
      throw err;
    });
  }
  return authPromise;
}

/** Verify a Google-issued ID token (fresh sign-in from the client SDK). */
export async function verifyIdToken(idToken: string): Promise<DecodedIdToken> {
  const auth = await getAdminAuth();
  return auth.verifyIdToken(idToken);
}

/** Verify the long-lived session cookie (checks revocation as well). */
export async function verifySessionCookie(cookie: string): Promise<DecodedIdToken> {
  const auth = await getAdminAuth();
  return auth.verifySessionCookie(cookie, true);
}

/** Exchange a fresh ID token for a session cookie valid for `expiresInMs`. */
export async function createSessionCookie(idToken: string, expiresInMs: number): Promise<string> {
  const auth = await getAdminAuth();
  return auth.createSessionCookie(idToken, { expiresIn: expiresInMs });
}
