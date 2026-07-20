import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getChatAttachment } from "@pebble/db";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * Authenticated download of a chat attachment (Chat overhaul WP7). Owner-
 * predicated lookup (`getChatAttachment` filters on the caller's own
 * `user_id`), so a foreign attachment id 404s the same as a missing one —
 * never leaks that it exists.
 *
 * Mirrors `app/api/documents/[id]/route.ts` / `app/api/source-documents/[id]/route.ts`:
 * `file://` uris stream from local disk, `gs://` uris are downloaded via the
 * GCS SDK (lazy import) under the runtime service account. Images render
 * `inline` (so the composer/message chips can preview them); every other
 * media type serves `attachment` (forces a download rather than an in-browser
 * render of, say, a CSV or a PDF the user meant to save).
 *
 * Node runtime: reads disk/GCS and shares the PGlite-backed db singleton.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith("image/");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Sign in required" }, 401);

  const { id } = await params;
  const { db } = await getDb();
  const attachment = await getChatAttachment(db, { id, userId: user.firebaseUid });
  if (!attachment) return json({ error: `Attachment ${id} not found` }, 404);

  let bytes: Buffer;

  if (attachment.storageUri.startsWith("gs://")) {
    // gs://bucket/key… — download via the GCS SDK under the runtime service
    // account. Lazy import keeps the heavy client out of dev/local paths.
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(attachment.storageUri);
    const bucket = match?.[1];
    const key = match?.[2];
    if (!bucket || !key) return json({ error: `Malformed gs:// uri on attachment ${id}` }, 500);
    try {
      const { Storage } = await import("@google-cloud/storage");
      const [downloaded] = await new Storage().bucket(bucket).file(key).download();
      bytes = downloaded;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return json({ error: `Fetching attachment ${id} from storage failed: ${detail}` }, 502);
    }
  } else if (attachment.storageUri.startsWith("file://")) {
    const abspath = fileURLToPath(attachment.storageUri);
    try {
      bytes = await readFile(abspath);
    } catch {
      return json({ error: `Stored file for attachment ${id} is missing on disk` }, 404);
    }
  } else {
    return json({ error: `Unsupported storage uri scheme on attachment ${id}` }, 501);
  }

  const disposition = isImageMediaType(attachment.mediaType) ? "inline" : "attachment";

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": attachment.mediaType || "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `${disposition}; filename="${attachment.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
