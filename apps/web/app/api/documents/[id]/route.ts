import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@pebble/db";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * Authenticated download of a generated document (Format A PDF / XLSX).
 *
 * The `generated_documents` row is the source of truth: its `storage_uri`
 * says where the bytes live. Local `file://` uris (the dev/default storage
 * backend) are streamed straight from disk; `gs://` uris are downloaded via
 * the GCS SDK (lazy import; the runtime service account has objectViewer on
 * the outputs bucket) and streamed through with the same headers — the auth
 * gate above is the access control, so no signed URLs are needed.
 *
 * Node runtime: reads disk/GCS and shares the PGlite-backed db singleton.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  PDF: "application/pdf",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Sign in required" }, 401);

  const { id } = await params;
  const { db } = await getDb();
  const rows = await db.select().from(schema.generatedDocuments);
  const doc = rows.find((r) => r.id === id);
  if (!doc) return json({ error: `Document ${id} not found` }, 404);

  let bytes: Buffer;
  let filename: string;

  if (doc.storageUri.startsWith("gs://")) {
    // gs://bucket/key… — download via the GCS SDK under the runtime service
    // account (objectViewer on the outputs bucket). Lazy import keeps the
    // heavy client out of dev/local paths entirely.
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(doc.storageUri);
    const bucket = match?.[1];
    const key = match?.[2];
    if (!bucket || !key) return json({ error: `Malformed gs:// uri on document ${id}` }, 500);
    try {
      const { Storage } = await import("@google-cloud/storage");
      const [downloaded] = await new Storage().bucket(bucket).file(key).download();
      bytes = downloaded;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return json({ error: `Fetching document ${id} from storage failed: ${detail}` }, 502);
    }
    filename = basename(key) || `document.${doc.kind.toLowerCase()}`;
  } else if (doc.storageUri.startsWith("file://")) {
    const abspath = fileURLToPath(doc.storageUri);
    try {
      bytes = await readFile(abspath);
    } catch {
      return json({ error: `Stored file for document ${id} is missing on disk` }, 404);
    }
    filename = basename(abspath) || `document.${doc.kind.toLowerCase()}`;
  } else {
    return json({ error: `Unsupported storage uri scheme on document ${id}` }, 501);
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPES[doc.kind] ?? "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
