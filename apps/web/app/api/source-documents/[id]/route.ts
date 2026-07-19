import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@pebble/db";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * Authenticated streaming access to a registered historical source document
 * (the original proposal PDF / DSR Excel a staged_record was extracted from).
 * Any signed-in role may view it — the verification queue's PDF pane and the
 * RAG search hit list both link here.
 *
 * Mirrors app/api/documents/[id]/route.ts (generated-document downloads):
 * `file://` uris stream from local disk, `gs://` uris are downloaded via the
 * GCS SDK (lazy import) under the runtime service account. Unlike that route
 * this one serves `inline` (not `attachment`) so the browser's built-in PDF
 * viewer can render it inside an <iframe src="…#page=N">.
 *
 * Node runtime: reads disk/GCS and shares the PGlite-backed db singleton.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

function contentTypeFor(filename: string): string {
  return CONTENT_TYPES_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

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
  const rows = await db.select().from(schema.sourceDocuments);
  const doc = rows.find((r) => r.id === id);
  if (!doc) return json({ error: `Source document ${id} not found` }, 404);

  let bytes: Buffer;
  let filename: string;

  if (doc.storageUri.startsWith("gs://")) {
    // gs://bucket/key… — download via the GCS SDK under the runtime service
    // account (objectViewer on the ingestion sources bucket). Lazy import
    // keeps the heavy client out of dev/local paths entirely.
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
      return json({ error: `Fetching source document ${id} from storage failed: ${detail}` }, 502);
    }
    filename = basename(key) || doc.filename;
  } else if (doc.storageUri.startsWith("file://")) {
    const abspath = fileURLToPath(doc.storageUri);
    try {
      bytes = await readFile(abspath);
    } catch {
      return json({ error: `Stored file for source document ${id} is missing on disk` }, 404);
    }
    filename = basename(abspath) || doc.filename;
  } else {
    return json({ error: `Unsupported storage uri scheme on source document ${id}` }, 501);
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(doc.filename || filename),
      "content-length": String(bytes.byteLength),
      "content-disposition": `inline; filename="${doc.filename || filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
