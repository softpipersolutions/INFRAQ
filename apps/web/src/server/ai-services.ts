import "server-only";

import {
  applyExtracted,
  buildEnquiryInput,
  buildExtractionPrompt,
  confirmAllProposed,
  createEmbedder,
  createGeminiModelFromEnv,
  detectConfirmedOverwrite,
  extractionSchema,
  FIELD_META,
  guardExtractedFields,
  modelConfigFromEnv,
  nextAction,
  SLOT_FIELDS,
  toLlmCallLog,
} from "@pebble/ai";
import type {
  CreateEnquiryResult,
  EnquiryStateSnapshot,
  EstimateSummary,
  ExtractedFields,
  PebbleAiServices,
  PrepareDocumentsResult,
  RepairEnquiryArgs,
  RepairEnquiryResult,
  SlotField,
  SlotState,
} from "@pebble/ai";
import {
  getChatSession,
  getVersionWithLines,
  hybridSearch,
  incrementContradictions,
  insertLlmCall,
  linkSessionEnquiry,
  listAuditForEstimate,
  loadMasterSnapshot,
  schema,
  setContradictions,
  updateSlotState,
  type Db,
} from "@pebble/db";
import type {
  DesignRule,
  Make,
  MasterSnapshot,
  Material,
  Price,
  SystemType,
} from "@pebble/shared";
import { WorkerError } from "@pebble/worker";
import { generateObject } from "ai";
import { createEnquiryAndGenerate } from "./generate";
import { createWorkerClient } from "./worker-client";
import { resolveSlotState } from "./chat-runtime";

/**
 * `PebbleAiServices` implemented over the SAME repositories/services the
 * structured screens use (spec §4.4 tools + the Phase-C.5 state-machine ops).
 * Two hard boundaries are preserved:
 *   - the model reads facts (materials/makes/prices/rules/history/audit) and may
 *     PROPOSE a line edit, but `proposeLineEdit` writes nothing — a human
 *     applies edits via tRPC;
 *   - enquiry creation goes through the exact validated create+generate path the
 *     form uses (`createEnquiryAndGenerate`), and — for the agent — the record is
 *     derived from the captured slot state (`createEnquiryFromState`), never from
 *     model-supplied values. Money is only ever computed by the engines.
 *
 * The master snapshot is loaded once per request instance and memoised, so a
 * multi-tool Claude turn does not re-query the masters for every lookup.
 */
export interface AiServicesDeps {
  db: Db;
  actor: string;
  actorRole: string | null;
  /** The chat session bound to this turn (slot-state mutations + enquiry link). */
  sessionId?: string;
}

const REQUIRED_FIELDS: SlotField[] = FIELD_META.filter((m) => m.required).map((m) => m.field);

class PebbleAiServicesImpl implements PebbleAiServices {
  private readonly db: Db;
  private readonly actor: string;
  private readonly actorRole: string | null;
  private readonly sessionId?: string;
  private snapshotPromise: Promise<MasterSnapshot> | null = null;

  constructor(deps: AiServicesDeps) {
    this.db = deps.db;
    this.actor = deps.actor;
    this.actorRole = deps.actorRole;
    this.sessionId = deps.sessionId;
  }

  private snapshot(): Promise<MasterSnapshot> {
    if (!this.snapshotPromise) this.snapshotPromise = loadMasterSnapshot(this.db);
    return this.snapshotPromise;
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error("PebbleAiServices: no chat session is bound to this turn");
    return this.sessionId;
  }

  async lookupMaterial(materialCode: string): Promise<Material | null> {
    const snap = await this.snapshot();
    return snap.materials.find((m) => m.materialCode === materialCode) ?? null;
  }

  async listMakesForMaterial(materialCode: string): Promise<Make[]> {
    const snap = await this.snapshot();
    return snap.makes.filter((mk) => mk.materialCode === materialCode);
  }

  async getCurrentPrice(materialCode: string, makeCode: string): Promise<Price | null> {
    const snap = await this.snapshot();
    return (
      snap.prices.find((p) => p.materialCode === materialCode && p.makeCode === makeCode) ?? null
    );
  }

  async getDesignRules(systemType: SystemType | null): Promise<DesignRule[]> {
    const snap = await this.snapshot();
    return systemType ? snap.rules.filter((r) => r.systemType === systemType) : snap.rules;
  }

  /**
   * "What did we quote before?" — mirrors routers/ingestion.ts search: best-effort
   * query embedding (a missing key / embedder failure falls back to tsvector-only,
   * the same null-embedding path hybridSearch supports) fused with the keyword arm.
   */
  async searchPastEstimates(query: string, limit: number) {
    let queryEmbedding: number[] | null = null;
    try {
      const embedder = createEmbedder(process.env);
      const [embedding] = await embedder.embed([query]);
      queryEmbedding = embedding ?? null;
    } catch {
      queryEmbedding = null;
    }
    const hits = await hybridSearch(this.db, { queryText: query, queryEmbedding, k: limit });
    return hits.map((h) => ({
      sourceFilename: h.filename,
      snippet: h.content,
      score: h.score,
      metadata: h.metadata ?? undefined,
    }));
  }

  /**
   * Fold newly-extracted fields into the session slot state (proposed values).
   * A confirmed slot changing to a different value is a contradiction — counted
   * on the persisted counter that feeds the Opus escalation guard (≥2).
   */
  async updateEnquiryDraft(sessionId: string, fields: ExtractedFields) {
    const state = await this.loadSlotState(sessionId);
    await this.recordContradictions(sessionId, state, fields);
    const next = applyExtracted(state, fields);
    await updateSlotState(this.db, sessionId, next);
    const na = nextAction(next);
    return {
      nextQuestion: na.kind === "ask" ? na.question : null,
      complete: na.kind !== "ask",
    };
  }

  /**
   * Extract fields from a long pasted block via Gemini Flash, auto-apply as
   * proposed, ledger the call, and return the capture snapshot. When no Google
   * lane is configured the snapshot is returned unchanged (nothing applied).
   */
  async extractFields(text: string): Promise<EnquiryStateSnapshot> {
    const sessionId = this.requireSession();
    const cfg = modelConfigFromEnv(process.env);
    const gemini = createGeminiModelFromEnv(process.env, cfg.gemini);
    if (!gemini) return this.buildSnapshot(sessionId);

    const state = await this.loadSlotState(sessionId);
    let fields: ExtractedFields;
    try {
      const { object, usage } = await generateObject({
        model: gemini,
        schema: extractionSchema,
        temperature: 0, // deterministic transcription — no enum "completion"
        prompt: buildExtractionPrompt(text, state),
      });
      fields = guardExtractedFields(object, text);
      await insertLlmCall(
        this.db,
        toLlmCallLog({
          lane: "gemini",
          model: cfg.gemini,
          intent: "EXTRACT",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          sessionId,
        }),
      );
    } catch (err) {
      console.error("[chat] extractFields failed:", err instanceof Error ? err.message : err);
      return this.buildSnapshot(sessionId);
    }

    await this.recordContradictions(sessionId, state, fields);
    const next = applyExtracted(state, fields);
    await updateSlotState(this.db, sessionId, next);
    return this.buildSnapshot(sessionId);
  }

  /**
   * Derive the enquiry record from the captured slot state and create it. The
   * model passes no values — what is created is exactly the confirmed slots the
   * user saw. Refuses (ok:false, issues) when an enquiry is already linked or the
   * derived record fails the shared validation gate.
   */
  async createEnquiryFromState(sessionId: string): Promise<CreateEnquiryResult> {
    const session = await getChatSession(this.db, sessionId);
    if (session?.enquiryId) {
      return { ok: false, issues: [`enquiry already created: ${session.enquiryId}`] };
    }

    const confirmed = confirmAllProposed(resolveSlotState(session?.slotState ?? null));
    const built = buildEnquiryInput(confirmed);
    if (!built.ok || !built.input) {
      return { ok: false, issues: built.issues ?? ["the captured record is incomplete"] };
    }

    const { enquiryId, estimateId } = await createEnquiryAndGenerate(
      this.db,
      built.input,
      this.actor,
      this.actorRole,
    );
    await linkSessionEnquiry(this.db, sessionId, enquiryId);
    await updateSlotState(this.db, sessionId, confirmed);
    return { ok: true, enquiryId, estimateId };
  }

  /**
   * The validated create+generate path the form uses (the interface's original
   * `createEnquiry`). Links the created enquiry to the bound session. The agent
   * itself creates via `createEnquiryFromState` (record derived from slot state);
   * this remains for any caller already holding a validated `EnquiryInput`.
   */
  async createEnquiry(input: Parameters<PebbleAiServices["createEnquiry"]>[0]) {
    const { enquiryId } = await createEnquiryAndGenerate(this.db, input, this.actor, this.actorRole);
    if (this.sessionId) await linkSessionEnquiry(this.db, this.sessionId, enquiryId);
    return { enquiryId };
  }

  /** Full capture state + validation issues + readiness + linked records — the self-heal diagnosis tool. */
  async getEnquiryState(sessionId: string): Promise<EnquiryStateSnapshot> {
    return this.buildSnapshot(sessionId);
  }

  /**
   * Typed corrections to the capture state: `set` overwrites fields (contradiction
   * detection applies), `clear` removes fields back to missing. Blocked once an
   * enquiry is linked — a created enquiry cannot be rewritten conversationally.
   */
  async repairEnquiryState(sessionId: string, args: RepairEnquiryArgs): Promise<RepairEnquiryResult> {
    const session = await getChatSession(this.db, sessionId);
    if (session?.enquiryId) {
      return {
        ok: false,
        issues: [`enquiry ${session.enquiryId} is already created — its record cannot be repaired here`],
      };
    }

    const state = resolveSlotState(session?.slotState ?? null);
    let next: SlotState = state;
    if (args.set && Object.keys(args.set).length > 0) {
      await this.recordContradictions(sessionId, state, args.set);
      next = applyExtracted(next, args.set);
    }
    if (args.clear && args.clear.length > 0) {
      next = { ...next };
      for (const f of args.clear) next[f] = { status: "missing", value: null };
    }
    await updateSlotState(this.db, sessionId, next);
    return { ok: true, snapshot: await this.buildSnapshot(sessionId) };
  }

  /**
   * Start the capture over (explicit user request only). Refuses to wipe a
   * session that already created an enquiry — that record stands; it returns the
   * current snapshot unchanged so the agent can explain.
   */
  async resetEnquiryCapture(sessionId: string): Promise<EnquiryStateSnapshot> {
    const session = await getChatSession(this.db, sessionId);
    if (session?.enquiryId) return this.buildSnapshot(sessionId);
    await updateSlotState(this.db, sessionId, null);
    await setContradictions(this.db, sessionId, 0);
    return this.buildSnapshot(sessionId);
  }

  /**
   * Queue the PDF/Excel render for a LOCKED version via the worker-client. An
   * expected worker failure (e.g. the version is not LOCKED → 400) is returned as
   * `{ok:false, issues}` so the agent relays it conversationally rather than
   * throwing mid-turn.
   */
  async prepareDocuments(estimateId: string): Promise<PrepareDocumentsResult> {
    try {
      const result = await createWorkerClient(this.db).render({ estimateId, actor: this.actor });
      return {
        ok: true,
        estimateId,
        jobId: result.pdf.id,
        status: "rendered",
      };
    } catch (err) {
      if (err instanceof WorkerError) {
        return { ok: false, estimateId, issues: [err.message] };
      }
      throw err;
    }
  }

  async getEstimateVersion(estimateId: string, versionNo: number | null) {
    const view = await getVersionWithLines(this.db, estimateId, versionNo ?? undefined);
    if (!view) return null;
    return {
      estimateId: view.estimate.estimateId,
      versionNo: view.version.versionNo,
      state: view.version.state,
      lines: view.lines,
      totalSitcPaise: view.version.totalSitcPaise,
      blendedRatio: view.version.blendedRatio,
    };
  }

  /**
   * The facts behind a line: its rule code + standard reference and the
   * RULE_APPLIED / PRICE_APPLIED audit payloads that produced it. Claude
   * explains from these — it does not re-derive quantities or prices.
   */
  async explainLine(estimateId: string, lineUid: string) {
    const view = await getVersionWithLines(this.db, estimateId);
    if (!view) return null;
    const line = view.lines.find((l) => l.lineUid === lineUid);
    if (!line) return null;

    const events = await listAuditForEstimate(this.db, estimateId);
    const rulePayloads = events
      .filter(
        (e) =>
          e.eventType === "RULE_APPLIED" &&
          line.ruleCode !== null &&
          e.payload.ruleCode === line.ruleCode,
      )
      .map((e) => e.payload);
    const pricePayloads = events
      .filter((e) => e.eventType === "PRICE_APPLIED" && e.payload.lineUid === lineUid)
      .map((e) => e.payload);

    let standardReference: string | null = null;
    const withRef = rulePayloads.find((p) => typeof p.standardReference === "string");
    if (withRef) {
      standardReference = withRef.standardReference as string;
    } else if (line.ruleCode) {
      const snap = await this.snapshot();
      standardReference = snap.rules.find((r) => r.ruleCode === line.ruleCode)?.standardReference ?? null;
    }

    return {
      lineUid,
      materialCode: line.materialCode,
      ruleCode: line.ruleCode,
      standardReference,
      auditPayloads: [...rulePayloads, ...pricePayloads],
    };
  }

  /** SUGGESTION ONLY — writes nothing. A human applies edits via tRPC. */
  async proposeLineEdit(args: Parameters<PebbleAiServices["proposeLineEdit"]>[0]) {
    const proposed: Record<string, unknown> = {};
    if (args.qty !== undefined) proposed.qty = args.qty;
    if (args.makeCode !== undefined) proposed.makeCode = args.makeCode;
    if (args.note !== undefined) proposed.note = args.note;
    return {
      estimateId: args.estimateId,
      lineUid: args.lineUid,
      proposed,
      rationale: args.editReason,
      applied: false as const,
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async loadSlotState(sessionId: string): Promise<SlotState> {
    const session = await getChatSession(this.db, sessionId);
    return resolveSlotState(session?.slotState ?? null);
  }

  /** Count confirmed-slot overwrites in `fields` against `prev` onto the persisted counter. */
  private async recordContradictions(
    sessionId: string,
    prev: SlotState,
    fields: ExtractedFields,
  ): Promise<void> {
    const overwrites = detectConfirmedOverwrite(prev, fields);
    if (overwrites.length > 0) await incrementContradictions(this.db, sessionId, overwrites.length);
  }

  /** Build the `EnquiryStateSnapshot` from the current slot state + any linked records. */
  private async buildSnapshot(sessionId: string): Promise<EnquiryStateSnapshot> {
    const session = await getChatSession(this.db, sessionId);
    const state = resolveSlotState(session?.slotState ?? null);
    const enquiryId = session?.enquiryId ?? null;

    const slots = {} as EnquiryStateSnapshot["slots"];
    const confirmed: SlotField[] = [];
    const proposed: SlotField[] = [];
    const missingRequired: SlotField[] = [];
    for (const f of SLOT_FIELDS) {
      slots[f] = { status: state[f].status, value: state[f].value };
      if (state[f].status === "confirmed") confirmed.push(f);
      else if (state[f].status === "proposed") proposed.push(f);
      else if (REQUIRED_FIELDS.includes(f)) missingRequired.push(f);
    }

    // Validate the confirm-all-proposed clone WITHOUT persisting — this is exactly
    // what createEnquiryFromState will build, so readiness matches the create gate.
    const built = buildEnquiryInput(confirmAllProposed(state));
    const issues = built.ok ? [] : built.issues ?? [];
    const readyToConfirm = issues.length === 0 && enquiryId === null;

    const estimateId = enquiryId ? (await this.estimateForEnquiry(enquiryId))?.estimateId ?? null : null;

    return {
      slots,
      confirmed,
      proposed,
      missingRequired,
      issues,
      readyToConfirm,
      enquiryId,
      estimateId,
      advisoryNextStep: advisoryNextStep({ enquiryId, missingRequired, issues }),
    };
  }

  /**
   * Resolve the estimate for a linked enquiry. There is no enquiry→estimate
   * repository (the app only ever goes estimate→enquiry), and `apps/web` cannot
   * import drizzle operators directly, so this reads the estimates table and
   * filters in JS — the same small-table pattern `auth.ts` uses for users. The
   * result is memoised per enquiry for the request instance.
   */
  private estimateCache = new Map<string, Promise<EstimateSummary | null>>();
  private estimateForEnquiry(enquiryId: string): Promise<EstimateSummary | null> {
    const cached = this.estimateCache.get(enquiryId);
    if (cached) return cached;
    const promise = (async (): Promise<EstimateSummary | null> => {
      const rows = await this.db.select().from(schema.estimates);
      const row = rows.find((r) => r.enquiryId === enquiryId);
      if (!row) return null;
      return {
        estimateId: row.estimateId,
        sitcStatus: row.sitcStatus ?? "unknown",
        versionNo: row.currentVersion,
      };
    })();
    this.estimateCache.set(enquiryId, promise);
    return promise;
  }

  /** Public seam for the route's session-state block (estimate summary for a linked enquiry). */
  async estimateSummaryForEnquiry(enquiryId: string): Promise<EstimateSummary | null> {
    return this.estimateForEnquiry(enquiryId);
  }
}

function advisoryNextStep(args: {
  enquiryId: string | null;
  missingRequired: SlotField[];
  issues: string[];
}): string {
  if (args.enquiryId) {
    return "An enquiry already exists for this session — help with the estimate or answer questions; do not create another.";
  }
  if (args.missingRequired.length > 0) {
    return `Capture is incomplete — still needed: ${args.missingRequired.join(", ")}. Ask for these (grouped), then restate and confirm.`;
  }
  if (args.issues.length > 0) {
    return `The captured values do not validate yet: ${args.issues.slice(0, 3).join("; ")}. Fix these before confirming.`;
  }
  return "All required fields are captured — restate the complete record and, on an explicit user yes, call create_enquiry.";
}

/**
 * The richer service surface the /api/chat route + tests use: the Phase-C.5
 * state-machine methods are OPTIONAL on `PebbleAiServices` (so a read-only
 * consumer still satisfies it) but this concrete implementation always provides
 * them, so we mark them required here and add the estimate-summary seam.
 */
export type PebbleChatServices = PebbleAiServices &
  Required<
    Pick<
      PebbleAiServices,
      | "extractFields"
      | "createEnquiryFromState"
      | "getEnquiryState"
      | "repairEnquiryState"
      | "resetEnquiryCapture"
      | "prepareDocuments"
    >
  > & {
    estimateSummaryForEnquiry(enquiryId: string): Promise<EstimateSummary | null>;
  };

export function createAiServices(deps: AiServicesDeps): PebbleChatServices {
  return new PebbleAiServicesImpl(deps);
}
