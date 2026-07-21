import { createChatModelsFromEnv } from "@pebble/ai";
import { bodySchema, jsonResponse, runAgentTurn } from "@/server/chat-agent";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * Conversational chat turn (Phase C.5) — a thin auth + parse wrapper over the
 * single agent turn (`runAgentTurn` in `src/server/chat-agent.ts`). Node runtime:
 * PGlite/pg, engines and the AI SDK are node-only. The turn streams a UI-message
 * response the `useChat` client consumes directly; tRPC covers the typed
 * control-plane (routers/chat.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
  const user = await getCurrentUser();
  if (!user) return jsonResponse(401, { error: "Sign in required" });

  // 2. Parse the body.
  let parsed: ReturnType<typeof bodySchema.parse>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return jsonResponse(400, { error: "Body must be { sessionId: string, message: string }" });
  }

  // 3. Run the agent turn.
  try {
    const { db } = await getDb();
    const models = createChatModelsFromEnv(process.env);
    return await runAgentTurn(
      { db, models },
      {
        sessionId: parsed.sessionId,
        message: parsed.message,
        user: { firebaseUid: user.firebaseUid, role: user.role },
        attachmentIds: parsed.attachmentIds,
        // WP13: the request aborts when the client disconnects (composer Stop /
        // navigation), cancelling the model call so the partial turn persists.
        abortSignal: req.signal,
      },
    );
  } catch (err) {
    console.error("[chat] handler error:", err instanceof Error ? err.stack : err);
    return jsonResponse(500, { error: "chat_failed", message: "The chat request could not be processed." });
  }
}
