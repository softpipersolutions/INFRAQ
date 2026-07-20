import { createStorage } from "@pebble/worker";
import { jsonResponse } from "@/server/chat-agent";
import {
  handleAttachmentUpload,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  type UploadFileInput,
} from "@/server/chat-attachments";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * File-upload endpoint for the chat composer (Chat overhaul WP7). Multipart
 * `POST` — `sessionId` field plus one or more `files` entries. Thin wrapper:
 * auth + `FormData` parsing here, everything with a decision to make
 * (allowlist, caps, dedup, storage, persistence) lives in
 * `src/server/chat-attachments.ts` (`handleAttachmentUpload`), mirroring
 * `app/api/chat/route.ts`'s split with `chat-agent.ts`. Node runtime: reads
 * disk/GCS storage and PGlite/pg, same as every other route under
 * `app/api/chat`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return jsonResponse(401, { error: "Sign in required" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(400, { error: "invalid_form", message: "Expected multipart/form-data." });
  }

  const sessionId = form.get("sessionId");
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return jsonResponse(400, { error: "missing_session", message: "sessionId is required." });
  }

  const fileEntries = form.getAll("files").filter((v): v is File => v instanceof File);
  if (fileEntries.length === 0) {
    return jsonResponse(400, { error: "no_files", message: "No files were attached." });
  }
  if (fileEntries.length > MAX_FILES_PER_REQUEST) {
    return jsonResponse(413, {
      error: "too_many_files",
      message: `Up to ${MAX_FILES_PER_REQUEST} files per message.`,
    });
  }

  const files: UploadFileInput[] = [];
  for (const f of fileEntries) {
    // Reject on the File's own reported size BEFORE reading its bytes — an
    // oversized file never gets buffered into memory.
    if (f.size > MAX_FILE_BYTES) {
      return jsonResponse(413, {
        error: "too_large",
        message: `"${f.name}" is larger than 20MB.`,
      });
    }
    const bytes = Buffer.from(await f.arrayBuffer());
    files.push({ filename: f.name, mediaType: f.type || "application/octet-stream", bytes });
  }

  const { db } = await getDb();
  const storage = createStorage(process.env);

  const result = await handleAttachmentUpload(
    { db, storage },
    { sessionId, userId: user.firebaseUid, files },
  );
  if (!result.ok) {
    return jsonResponse(result.status, { error: result.error, message: result.message });
  }
  return jsonResponse(200, { attachments: result.attachments });
}
