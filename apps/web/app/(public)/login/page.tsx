"use client";

import Image from "next/image";
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

/** A sign-in that reached the server but was denied by the allowlist (403). */
class AccessDeniedError extends Error {
  constructor(public deniedEmail: string | null) {
    super("This Google account is not authorised for Pebble.");
    this.name = "AccessDeniedError";
  }
}

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
    if (res.status === 403) throw new AccessDeniedError(credential.user.email);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Sign-in failed (${res.status})`);
  }
  window.location.href = "/chat";
}

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deniedEmail, setDeniedEmail] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    setDeniedEmail(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        setDeniedEmail(err.deniedEmail ?? "your account");
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      }
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-4">
      <div className="mb-6 flex justify-center">
        <Image
          src="/brand/monogram.png"
          alt="Greenberg Engineering monogram"
          width={48}
          height={48}
          className="rounded-lg"
        />
      </div>

      {deniedEmail ? (
        <div className="rounded-lg border border-border bg-surface-sunken p-8 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">Access not yet granted</div>
          <div className="mt-3 font-mono text-sm text-ink">{deniedEmail}</div>
          <p className="mt-4 text-sm text-ink-secondary">
            Ask your Pebble admin to add you to the allowlist, then sign in again.
          </p>
          <div className="mt-6">
            <Button variant="secondary" disabled={busy} onClick={() => setDeniedEmail(null)}>
              Back to sign in
            </Button>
          </div>
        </div>
      ) : (
        <Card className="p-8 text-center">
          <div className="text-lg font-semibold tracking-tight text-ink">Pebble</div>
          <div className="mt-1 text-sm text-ink-muted">
            Estimate Crafting Space · Greenberg Engineering
          </div>

          {configured ? (
            <>
              <p className="mt-6 text-sm text-ink-secondary">
                Sign in with your authorised Google account to continue.
              </p>
              <div className="mt-4">
                <Button variant="primary" disabled={busy} onClick={onSignIn}>
                  {busy ? "Signing in…" : "Sign in with Google"}
                </Button>
              </div>
              {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
            </>
          ) : (
            <>
              <p className="mt-6 text-sm text-ink-secondary">
                Firebase is not configured (NEXT_PUBLIC_FIREBASE_* unset) — dev mode is active and
                every screen runs as the local dev admin.
              </p>
              <div className="mt-4">
                <Link href="/dashboard">
                  <Button variant="primary">Go to dashboard</Button>
                </Link>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
