import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Storage } from "@google-cloud/storage";

/**
 * Storage abstraction for rendered outputs (Format A PDF / XLSX).
 *
 * The worker renders once and must hand back a *stable, content-addressed*
 * reference the rest of the system persists (`generated_documents.storage_uri`
 * + `sha256`) and later re-shares as a signed URL. Two concerns are kept apart
 * on purpose:
 *   - `put` returns an opaque `uri` (a `file://` path locally, a `gs://` path in
 *     GCP) plus the sha256 of the exact bytes we wrote, so integrity is checked
 *     against what landed in storage, not what we intended to write.
 *   - `signedUrl` turns that opaque uri into a time-limited, directly-fetchable
 *     URL for email attachments / WhatsApp media.
 *
 * The local adapter is the zero-config default so a fresh checkout renders and
 * "dispatches" documents with no cloud credentials; GCS is selected by env in
 * production.
 */

export interface PutResult {
  /** Opaque, backend-specific locator persisted on the document row. */
  uri: string;
  /** Hex sha256 of the exact bytes stored — the integrity anchor. */
  sha256: string;
}

export interface StorageAdapter {
  /** Store `bytes` under `key`, returning its uri and content hash. */
  put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<PutResult>;
  /** Resolve a stored `uri` to a fetchable URL valid for `ttlSeconds`. */
  signedUrl(uri: string, ttlSeconds: number): Promise<string>;
  /** Fetch a stored object's bytes back — used by ingestion to re-read a
   *  registered source document (PDF/XLSX) for windowing/parsing. */
  get(uri: string): Promise<Buffer>;
  /**
   * Resolve a storage KEY (as passed to `put`) to the opaque uri it is stored
   * under, WITHOUT writing. `put` is the only thing that hands back a uri, so a
   * resumable pipeline that persists a work file (`ingest-work/<id>/meta.json`)
   * in one invocation and must re-read it in a later one needs a pure
   * key→uri mapping — that is this. It is the exact inverse of the key→uri that
   * `put` returns for the same key.
   */
  keyToUri(key: string): string;
}

/** Hex sha256 of the exact bytes we are about to (or did) store. */
function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalise our `Buffer | Uint8Array` inputs to a Buffer for the fs/GCS APIs. */
function toBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * Local filesystem adapter — the default for dev, tests and demos.
 *
 * Files are written under `baseDir/<key>` (nested dirs created on demand) and
 * addressed by a `file://<abspath>` uri. Because the uri already encodes the
 * absolute path, `signedUrl` is a no-op that simply hands the `file://` back:
 * there is nothing to sign locally, and returning the same scheme keeps the
 * call site identical whether it is wired to Local or GCS.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly backend = "local";
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async put(key: string, bytes: Buffer | Uint8Array, _contentType: string): Promise<PutResult> {
    const buf = toBuffer(bytes);
    // Join manually (not path.join) so a key like "estimates/x/y.pdf" always
    // nests under baseDir even on platforms with different separators.
    const abspath = resolve(this.baseDir, key);
    await mkdir(dirname(abspath), { recursive: true });
    await writeFile(abspath, buf);
    return { uri: pathToFileURL(abspath).href, sha256: sha256Hex(buf) };
  }

  async signedUrl(uri: string, _ttlSeconds: number): Promise<string> {
    // A local file:// uri is already directly usable; return it verbatim.
    if (uri.startsWith("file://")) return uri;
    // Tolerate a bare absolute path too (defensive — some callers store paths).
    if (isAbsolute(uri)) return pathToFileURL(uri).href;
    return uri;
  }

  /** Read stored bytes back — used by tests and any local re-serve path. */
  async read(uri: string): Promise<Buffer> {
    const abspath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    return readFile(abspath);
  }

  /** `StorageAdapter.get` — identical to `read`; kept as a distinct method so
   *  callers can depend on the `StorageAdapter` interface alone. */
  async get(uri: string): Promise<Buffer> {
    return this.read(uri);
  }

  /** `file://<baseDir>/<key>` — the same uri `put(key, …)` returns. */
  keyToUri(key: string): string {
    return pathToFileURL(resolve(this.baseDir, key)).href;
  }
}

/**
 * Google Cloud Storage adapter.
 *
 * Construction is deliberately side-effect free: we only remember the bucket
 * name and lazily instantiate the `Storage` client (which resolves ADC /
 * metadata credentials) on first use. That keeps `createStorage` safe to call
 * on every boot — including in environments with no GCP credentials — as long
 * as GCS is not actually selected.
 */
export class GcsStorageAdapter implements StorageAdapter {
  readonly backend = "gcs";
  private readonly bucketName: string;
  private client: Storage | null = null;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
  }

  /** Lazily construct the SDK client so the constructor never touches GCP. */
  private async bucket() {
    if (!this.client) {
      // Dynamic import keeps the (heavy, credential-resolving) SDK out of the
      // module graph unless GCS is genuinely used.
      const { Storage } = await import("@google-cloud/storage");
      this.client = new Storage();
    }
    return this.client.bucket(this.bucketName);
  }

  private keyFromUri(uri: string): string {
    const prefix = `gs://${this.bucketName}/`;
    return uri.startsWith(prefix) ? uri.slice(prefix.length) : uri.replace(/^gs:\/\/[^/]+\//, "");
  }

  async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<PutResult> {
    const buf = toBuffer(bytes);
    const bucket = await this.bucket();
    await bucket.file(key).save(buf, { contentType, resumable: false });
    return { uri: `gs://${this.bucketName}/${key}`, sha256: sha256Hex(buf) };
  }

  async signedUrl(uri: string, ttlSeconds: number): Promise<string> {
    const bucket = await this.bucket();
    const [url] = await bucket.file(this.keyFromUri(uri)).getSignedUrl({
      action: "read",
      expires: Date.now() + ttlSeconds * 1000,
    });
    return url;
  }

  /**
   * Fetch stored bytes back via the GCS SDK's `file.download()`. Honors the
   * uri's OWN bucket when it names one — ingestion reads source documents from
   * the corpus bucket (`gs://$INGEST_GCS_BUCKET/...`) through the same adapter
   * that writes work files to the outputs bucket, so `get` must never silently
   * re-root a foreign `gs://` uri onto the configured bucket.
   */
  async get(uri: string): Promise<Buffer> {
    if (uri.startsWith("gs://") && !uri.startsWith(`gs://${this.bucketName}/`)) {
      const { bucket: foreignBucket, key } = parseGsUri(uri);
      if (!this.client) {
        const { Storage } = await import("@google-cloud/storage");
        this.client = new Storage();
      }
      const [buf] = await this.client.bucket(foreignBucket).file(key).download();
      return buf;
    }
    const bucket = await this.bucket();
    const [buf] = await bucket.file(this.keyFromUri(uri)).download();
    return buf;
  }

  /** `gs://<bucket>/<key>` — the same uri `put(key, …)` returns. */
  keyToUri(key: string): string {
    return `gs://${this.bucketName}/${key}`;
  }
}

/**
 * Parse a `gs://bucket/key` uri into its parts. Exported standalone so the
 * (trivial, side-effect-free) parsing logic can be unit-tested without
 * touching the `@google-cloud/storage` SDK.
 */
export function parseGsUri(uri: string): { bucket: string; key: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Not a gs:// uri: ${uri}`);
  return { bucket: m[1] ?? "", key: m[2] ?? "" };
}

/**
 * Standalone signed-URL helper for an arbitrary `gs://` uri, independent of
 * any single `GcsStorageAdapter`'s configured bucket — the bucket and key are
 * parsed FROM THE URI, so this works for a uri from a different bucket than
 * whatever the adapter was constructed with (e.g. the ingestion corpus
 * bucket vs the rendered-output bucket). The SDK import is lazy, matching
 * `GcsStorageAdapter`'s pattern of never touching GCP credentials until a
 * GCS operation is genuinely requested.
 */
export async function signedUrlForGsUri(uri: string, ttlSeconds: number): Promise<string> {
  const { bucket: bucketName, key } = parseGsUri(uri);
  const { Storage } = await import("@google-cloud/storage");
  const client = new Storage();
  const [url] = await client
    .bucket(bucketName)
    .file(key)
    .getSignedUrl({ action: "read", expires: Date.now() + ttlSeconds * 1000 });
  return url;
}

/**
 * Pick a storage backend from the environment. GCS is used only when explicitly
 * requested (`STORAGE_BACKEND=gcs`) *and* a bucket is named; otherwise the local
 * adapter under `LOCAL_STORAGE_DIR` (default `.data/outputs`) — the zero-config
 * default that needs no cloud credentials.
 */
export function createStorage(env: Record<string, string | undefined>): StorageAdapter {
  if (env.STORAGE_BACKEND === "gcs" && env.GCS_BUCKET) {
    return new GcsStorageAdapter(env.GCS_BUCKET);
  }
  return new LocalStorageAdapter(env.LOCAL_STORAGE_DIR ?? ".data/outputs");
}
