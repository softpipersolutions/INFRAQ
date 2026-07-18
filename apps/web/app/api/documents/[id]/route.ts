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
 * backend) are streamed straight from disk with the right content type and an
 * attachment disposition. `gs://` uris will redirect to a GCS signed URL once
 * the production storage path is wired end-to-end; until then they get an
 * explicit 501 rather than a misleading 404.
 *
 * Node runtime: reads local disk and shares the PGlite-backed db singleton.
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

  if (doc.storageUri.startsWith("gs://")) {
    return json(
      {
        error:
          "GCS-backed downloads are not wired yet — this deployment should redirect to a signed URL. Use local storage (STORAGE_BACKEND=local) for now.",
      },
      501,
    );
  }

  if (!doc.storageUri.startsWith("file://")) {
    return json({ error: `Unsupported storage uri scheme on document ${id}` }, 501);
  }

  const abspath = fileURLToPath(doc.storageUri);
  let bytes: Buffer;
  try {
    bytes = await readFile(abspath);
  } catch {
    return json({ error: `Stored file for document ${id} is missing on disk` }, 404);
  }

  const filename = basename(abspath) || `document.${doc.kind.toLowerCase()}`;
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
