"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card } from "@/components/ui";

/**
 * NEXT_PUBLIC_* values are inlined at build time; when absent (dev mode, or a
 * build with no Firebase project attached yet) the page renders a plain
 * "not configured" card instead of crashing. The Firebase client SDK is
 * imported dynamically so it never lands in the initial bundle.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const configured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

async function signInWithGoogle(): Promise<void> {
  const { getApps, initializeApp } = await import("firebase/app");
  const { GoogleAuthProvider, getAuth, signInWithPopup } = await import("firebase/auth");

  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const credential = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  const idToken = await credential.user.getIdToken();

  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Sign-in failed (${res.status})`);
  }
  window.location.href = "/";
}

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card className="p-8 text-center">
        <div className="text-lg font-semibold tracking-tight">Pebble</div>
        <div className="mt-1 text-sm text-[var(--pebble-muted)]">
          Estimate Crafting Space · Greenberg Enterprises
        </div>

        {configured ? (
          <>
            <p className="mt-6 text-sm text-[var(--pebble-muted)]">
              Sign in with your authorised Google account to continue.
            </p>
            <div className="mt-4">
              <Button variant="primary" disabled={busy} onClick={onSignIn}>
                {busy ? "Signing in…" : "Sign in with Google"}
              </Button>
            </div>
            {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
          </>
        ) : (
          <>
            <p className="mt-6 text-sm text-[var(--pebble-muted)]">
              Firebase is not configured (NEXT_PUBLIC_FIREBASE_* unset) — dev mode is active and
              every screen runs as the local dev admin.
            </p>
            <div className="mt-4">
              <Link href="/">
                <Button variant="primary">Go to dashboard</Button>
              </Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
