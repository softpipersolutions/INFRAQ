import "server-only";

import { createEmbedder } from "@pebble/ai";
import type { ExtractedFields, PebbleAiServices } from "@pebble/ai";
import {
  getChatSession,
  getVersionWithLines,
  hybridSearch,
  linkSessionEnquiry,
  listAuditForEstimate,
  loadMasterSnapshot,
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
import {
  allRequiredConfirmed,
  applyExtracted,
  nextAction,
} from "@pebble/ai";
import { createEnquiryAndGenerate } from "./generate";
import { resolveSlotState } from "./chat-runtime";

/**
 * `PebbleAiServices` implemented over the SAME repositories/services the
 * structured screens use (spec §4.4 tools). Two hard boundaries are preserved:
 *   - the model reads facts (materials/makes/prices/rules/history/audit) and
 *     may PROPOSE a line edit, but `proposeLineEdit` writes nothing — a human
 *     applies edits via tRPC;
 *   - `createEnquiry` goes through the exact validated create+generate path the
 *     form uses (`createEnquiryAndGenerate`), so money is only ever computed by
 *     the deterministic engines.
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

  /** Fold newly-extracted fields into the session slot state (proposed values). */
  async updateEnquiryDraft(sessionId: string, fields: ExtractedFields) {
    const session = await getChatSession(this.db, sessionId);
    const state = resolveSlotState(session?.slotState ?? null);
    const next = applyExtracted(state, fields);
    await updateSlotState(this.db, sessionId, next);
    const na = nextAction(next);
    return {
      nextQuestion: na.kind === "ask" ? na.question : null,
      complete: na.kind !== "ask",
    };
  }

  /**
   * The validated create+generate path the form uses. Links the created
   * enquiry back to the chat session when one is bound to this turn.
   */
  async createEnquiry(input: Parameters<PebbleAiServices["createEnquiry"]>[0]) {
    const { enquiryId } = await createEnquiryAndGenerate(
      this.db,
      input,
      this.actor,
      this.actorRole,
    );
    if (this.sessionId) await linkSessionEnquiry(this.db, this.sessionId, enquiryId);
    return { enquiryId };
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
}

export function createAiServices(deps: AiServicesDeps): PebbleAiServices {
  return new PebbleAiServicesImpl(deps);
}
