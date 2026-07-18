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
