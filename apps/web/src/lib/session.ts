/**
 * Session cookie contract shared by the auth server code, the /api/auth/session
 * route and middleware.ts. Constants only — this module must stay free of any
 * Node/Firebase imports because middleware runs on the edge runtime.
 */

/** httpOnly cookie holding the Firebase session cookie (AUTH_MODE=firebase). */
export const SESSION_COOKIE_NAME = "__pebble_session";

/** Session lifetime: 14 days (Firebase allows 5 minutes – 14 days). */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
