/**
 * The Anthropic Skills lane (Chat overhaul WP8, flagged `PEBBLE_SKILLS_LANE=1`).
 *
 * A THIN raw client over the Anthropic Files API + the code-execution container
 * + built-in Office skills (xlsx/docx/pptx). We deliberately do NOT depend on
 * `@anthropic-ai/sdk` here — the two calls we need (upload a file, run one
 * messages request with the code-execution + skills betas) are a couple of
 * `fetch`es, and injecting the `fetch` implementation keeps the whole lane
 * unit-testable with a stubbed transport and NO live API key. `@ai-sdk/anthropic`
 * (the streaming chat provider) does not surface the Files API or the skills
 * betas, so a small purpose-built client is the right seam.
 *
 * Two capabilities:
 *   - `analyzeOfficeFile` — upload the office file to the Files API, then run a
 *     messages call with a code-execution container that references it via a
 *     `container_upload` block and the relevant built-in skill, returning the
 *     model's text analysis.
 *   - `generateOfficeFile` — run the same lane asking the model to PRODUCE a
 *     working file with the appropriate skill, then download the generated file
 *     bytes back off the container/Files API.
 *
 * Everything is defensive: a lane error surfaces as a thrown `SkillsLaneError`
 * the tool layer turns into a clear failure string — it never takes the turn
 * down. The generated artifacts are DRAFT working files, never official
 * letterhead documents (those come only from `prepare_documents`).
 */

/** The betas the Files API + Skills + code-execution container require. */
export const SKILLS_LANE_BETAS = "files-api-2025-04-14,skills-2025-10-02,code-execution-2025-08-25";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** The Office formats the built-in skills cover, mapped to skill id + media type. */
export const OFFICE_FORMATS = {
  xlsx: {
    skillId: "xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  docx: {
    skillId: "docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  pptx: {
    skillId: "pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
} as const;

export type OfficeFormat = keyof typeof OFFICE_FORMATS;

export class SkillsLaneError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SkillsLaneError";
    this.status = status;
  }
}

/** A `fetch`-compatible function — injected so tests can stub the transport. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SkillsLaneConfig {
  apiKey: string;
  /** The model that drives the code-execution/skills request (env-resolved id). */
  model: string;
  /** Injected transport (defaults to global `fetch`) — stubbed in tests. */
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Cap on the container run (ms). */
  maxTokens?: number;
}

export interface UploadedFile {
  fileId: string;
  filename: string;
}

export interface AnalyzeOfficeArgs {
  /** A prior Files-API id, OR raw bytes to upload first. */
  fileId?: string;
  bytes?: Uint8Array;
  filename: string;
  mediaType: string;
  /** What the user wants to know / do with the file. */
  instruction: string;
}

export interface GeneratedFile {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

export interface GenerateOfficeArgs {
  instruction: string;
  /** Optional supporting context (e.g. extracted estimate figures) for the model. */
  contextText?: string;
  format: OfficeFormat;
  /** Base filename (without extension) for the generated draft. */
  filenameStem?: string;
}

/**
 * The skills-lane client. Constructed from env in `apps/web` (only when the flag
 * is on); the tools call these two methods.
 */
export class SkillsLane {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(config: SkillsLaneConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxTokens = config.maxTokens ?? 8192;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": SKILLS_LANE_BETAS,
      ...extra,
    };
  }

  /** Upload raw bytes to the Files API, returning its id (multipart/form-data). */
  async uploadToFilesApi(bytes: Uint8Array, filename: string, mediaType: string): Promise<UploadedFile> {
    const form = new FormData();
    // `Blob` from a Uint8Array — Node 18+ / the Web runtime both support this.
    // Cast to ArrayBuffer (a global in every lib target) keeps us portable across
    // tsconfig `lib` settings (this package has no DOM lib, so `BlobPart` is unknown).
    form.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: mediaType }), filename);

    const res = await this.fetchImpl(`${this.baseUrl}/v1/files`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    const json = await this.readJson(res, "upload file");
    const fileId = typeof json?.id === "string" ? json.id : null;
    if (!fileId) throw new SkillsLaneError("Files API did not return a file id.");
    return { fileId, filename };
  }

  /**
   * Analyze an office file: ensure it's in the Files API, then run a
   * code-execution container messages call that mounts it via a
   * `container_upload` block. Returns the model's text analysis.
   */
  async analyzeOfficeFile(args: AnalyzeOfficeArgs): Promise<string> {
    let fileId = args.fileId;
    if (!fileId) {
      if (!args.bytes) throw new SkillsLaneError("analyzeOfficeFile needs a fileId or bytes.");
      fileId = (await this.uploadToFilesApi(args.bytes, args.filename, args.mediaType)).fileId;
    }

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      container: { skills: officeSkillsForMediaType(args.mediaType) },
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "container_upload", file_id: fileId },
            {
              type: "text",
              text:
                `The user attached the file "${args.filename}". ` +
                `Using the code execution container and the relevant Office skill, ` +
                `do the following and answer in clear prose (no file output needed):\n\n${args.instruction}`,
            },
          ],
        },
      ],
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const json = await this.readJson(res, "analyze office file");
    const text = extractText(json);
    if (!text) throw new SkillsLaneError("The analysis returned no text.");
    return text;
  }

  /**
   * Generate a DRAFT office file. Runs the skills lane asking the model to
   * produce the file, then downloads the first file the container emitted (via
   * the Files API) and returns its bytes. The output is a working draft, never
   * an official document.
   */
  async generateOfficeFile(args: GenerateOfficeArgs): Promise<GeneratedFile> {
    const fmt = OFFICE_FORMATS[args.format];
    const stem = sanitizeStem(args.filenameStem) ?? "pebble-draft";
    const filename = `${stem}.${fmt.extension}`;

    const contextBlock = args.contextText ? `\n\nContext to work from:\n${args.contextText}` : "";
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      container: { skills: [{ type: "skill", skill_id: fmt.skillId }] },
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Using the code execution container and the ${fmt.skillId} skill, create a ${args.format} ` +
                `file named "${filename}". This is a DRAFT working file, not an official document.\n\n` +
                `${args.instruction}${contextBlock}`,
            },
          ],
        },
      ],
    };

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const json = await this.readJson(res, "generate office file");

    const fileId = extractGeneratedFileId(json);
    if (!fileId) {
      throw new SkillsLaneError("The generation did not produce a downloadable file.");
    }
    const bytes = await this.downloadFile(fileId);
    return { bytes, filename, mediaType: fmt.mediaType };
  }

  /** Download a Files-API object's bytes. */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/files/${fileId}/content`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new SkillsLaneError(`Downloading generated file failed (HTTP ${res.status}).`, res.status);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  private async readJson(res: Response, what: string): Promise<Record<string, unknown>> {
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = errorMessageOf(payload) ?? `Anthropic ${what} failed (HTTP ${res.status}).`;
      throw new SkillsLaneError(message, res.status);
    }
    if (!payload) throw new SkillsLaneError(`Anthropic ${what} returned no JSON.`);
    return payload;
  }
}

// ─── Response shape helpers (defensive — the lane must never throw a raw TypeError) ──

/** The built-in skill(s) to mount for a given media type. */
function officeSkillsForMediaType(mediaType: string): Array<{ type: "skill"; skill_id: string }> {
  const t = mediaType.trim().toLowerCase();
  for (const fmt of Object.values(OFFICE_FORMATS)) {
    if (t === fmt.mediaType) return [{ type: "skill", skill_id: fmt.skillId }];
  }
  // Default to all three so the container can read whatever it is handed.
  return Object.values(OFFICE_FORMATS).map((f) => ({ type: "skill" as const, skill_id: f.skillId }));
}

/** Concatenate the text blocks of a messages response. */
function extractText(json: Record<string, unknown>): string {
  const content = json.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Find the first generated file id in a code-execution messages response. The
 * container surfaces produced files inside `code_execution_tool_result` blocks
 * (`content.content[].file_id`); we scan defensively for any `file_id`.
 */
function extractGeneratedFileId(json: Record<string, unknown>): string | null {
  const seen: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.file_id === "string") seen.push(rec.file_id);
    for (const value of Object.values(rec)) walk(value);
  };
  walk(json.content);
  return seen[0] ?? null;
}

function errorMessageOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const err = payload.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return null;
}

function sanitizeStem(stem: string | undefined): string | null {
  if (!stem) return null;
  const cleaned = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : null;
}

/**
 * Build the lane from env, or `null` when the flag is off / no key is set. The
 * caller (apps/web) never constructs a provider itself — this is the single
 * env → lane seam, mirroring `chat-model.ts`.
 */
export function createSkillsLaneFromEnv(
  env: Record<string, string | undefined>,
  opts: { model: string; fetchImpl?: FetchLike },
): SkillsLane | null {
  if (env.PEBBLE_SKILLS_LANE !== "1") return null;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new SkillsLane({ apiKey, model: opts.model, fetchImpl: opts.fetchImpl });
}

/** True when the skills lane flag is enabled (tools composed / prompt cost paid). */
export function skillsLaneEnabled(env: Record<string, string | undefined>): boolean {
  return env.PEBBLE_SKILLS_LANE === "1";
}
