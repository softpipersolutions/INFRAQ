import { StubEmbedder } from "@pebble/ai";
import type { LanguageModel } from "@pebble/ai";
import type { DbHandle } from "@pebble/db";
import { insertStagedRecords, newUlid, registerSourceDocument, startExtractionRun } from "@pebble/db";
import type { NewStagedRecord } from "@pebble/db";
import { auditEvents, llmCalls, materials, stagedRecords } from "@pebble/db/schema";
import { StubEmailProvider, StubWhatsAppProvider } from "@pebble/dispatch";
import type {
  StagedMakeLink,
  StagedMaterialBundle,
  StagedPricePoint,
} from "@pebble/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/app";
import { autoApproveBatch } from "../src/auto-approve";
import type { AutoApproveDeps } from "../src/auto-approve";
import { StubPdfRenderer } from "../src/pdf";
import { LocalStorageAdapter } from "../src/storage";
import { freshDb, tempStorageDir } from "./helpers";

/**
 * Auto-approve pipeline tests — everything on PGlite with a scripted stub
 * verifier (zero network). The stub reads a `[v:approve|reject|unsure]` marker
 * planted in each record's sourceText, so verdicts are deterministic regardless
 * of how the batch's concurrent verifications interleave.
 */

// ─── Scripted stub verifier ──────────────────────────────────────────────────

function verdictStub(): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "stub-provider",
    modelId: "gemini-verify-test",
    supportedUrls: {},
    doGenerate: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      const userMessage = options.prompt.find((m) => m.role === "user");
      const parts = (userMessage?.content ?? []) as Array<{ type: string; text?: string }>;
      const text = parts.find((p) => p.type === "text")?.text ?? "";
      const verdict: "approve" | "reject" | "unsure" = /\[v:approve\]/.test(text)
        ? "approve"
        : /\[v:reject\]/.test(text)
          ? "reject"
          : "unsure";
      const payload = {
        verdict,
        confidence: verdict === "approve" ? 0.95 : 0.4,
        issues: verdict === "approve" ? [] : [`stub ${verdict} reason`],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: "stop",
        usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("doStream not implemented in stub");
    },
  } as unknown as LanguageModel;
}

function deps(handle: DbHandle, model: LanguageModel | null): AutoApproveDeps {
  return { db: handle.db, ai: { model, embedder: new StubEmbedder() } };
}

// ─── Payload builders (all carry a [v:*] verdict marker in sourceText) ────────

function materialBundle(marker: string, name: string, code: string): StagedMaterialBundle {
  return {
    payloadVersion: 1,
    material: {
      materialCode: code,
      materialName: name,
      systemType: "Sprinkler",
      category: "Valve",
      unitOfMeasure: { raw: "No.", normalized: "No." },
    },
    make: { brandName: { raw: "Zorbex", normalized: null } },
    price: { sellRupees: 12500, rateKind: "SITC", validFromISO: "2024-05-01T00:00:00.000Z" },
    sourceText: `SITC ${name}; Make - Zorbex ${marker}`,
  };
}

function pricePoint(marker: string, materialCode: string): StagedPricePoint {
  return {
    payloadVersion: 1,
    materialCode,
    brandName: { raw: "Agni", normalized: "Agni Devices" },
    sellRupees: 1500,
    rateKind: "SITC",
    validFromISO: "2024-05-01T00:00:00.000Z",
    sourceText: `Photoelectric Smoke Detector; Make - Agni ${marker}`,
  };
}

function makeLink(marker: string, materialCode: string): StagedMakeLink {
  return {
    payloadVersion: 1,
    materialCode,
    brandName: { raw: "Honeywell", normalized: "Honeywell" },
    sourceText: `Manual Call Point; Make - Honeywell ${marker}`,
  };
}

// ─── Seeding helpers ─────────────────────────────────────────────────────────

/** Register a source doc + run and stage a batch of (schema-valid) proposed rows. */
async function seedValid(handle: DbHandle, records: NewStagedRecord[]): Promise<string> {
  const { id: docId } = await registerSourceDocument(handle.db, {
    filename: "FF-77 Auto Approve Test (01052024 R0).pdf",
    storageUri: `file:///seed/${newUlid()}.pdf`,
    docType: "proposal",
  });
  const runId = await startExtractionRun(handle.db, {
    sourceDocumentId: docId,
    model: "seed",
    promptVersion: "seed-v1",
  });
  await insertStagedRecords(handle.db, runId, records);
  return runId;
}

/** Insert a raw staged row whose payload does NOT validate (bypasses the repo guard). */
async function seedInvalidRow(handle: DbHandle, runId: string): Promise<string> {
  const id = newUlid();
  await handle.db.insert(stagedRecords).values({
    id,
    extractionRunId: runId,
    targetMaster: "materials",
    proposed: { garbage: true, not: "a bundle" },
    confidence: null,
    dedupCandidateCode: null,
    sourceLocator: null,
    status: "PROPOSED",
  });
  return id;
}

async function allStaged(handle: DbHandle) {
  return handle.db.select().from(stagedRecords);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("autoApproveBatch", () => {
  let handle: DbHandle;
  beforeEach(async () => {
    handle = await freshDb();
  });
  afterEach(async () => {
    await handle.close();
  });

  it("approve → commits the row into the masters as gemini-auto, ledgers the call", async () => {
    await seedValid(handle, [
      { targetMaster: "materials", proposed: materialBundle("[v:approve]", "Zorbex Deluge Actuator Valve 150mm", "SPR-VLV-900"), confidence: 0.9 },
    ]);

    const report = await autoApproveBatch(deps(handle, verdictStub()));

    expect(report.processed).toBe(1);
    expect(report.approved).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.unsure).toBe(0);
    expect(report.skippedInvalid).toBe(0);
    expect(report.dryRun).toBe(false);
    expect(report.remainingProposed).toBe(0);
    expect(report.costUsd).toBeGreaterThan(0);

    // The staged row is APPROVED, stamped by the machine reviewer.
    const staged = await allStaged(handle);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.status).toBe("APPROVED");
    expect(staged[0]?.reviewedBy).toBe("gemini-auto");

    // The master material now exists (fresh — novel name, no dedup match).
    const mats = await handle.db.select().from(materials);
    expect(mats.some((m) => m.materialName === "Zorbex Deluge Actuator Valve 150mm")).toBe(true);

    // STAGED_COMMITTED audit event was written by the commit, as gemini-auto.
    const audits = await handle.db.select().from(auditEvents);
    const committed = audits.filter((a) => a.eventType === "STAGED_COMMITTED");
    expect(committed).toHaveLength(1);
    expect(committed[0]?.actor).toBe("gemini-auto");
    expect((committed[0]?.payload as { decision?: string }).decision).toBe("APPROVED");

    // The Gemini call was ledgered with intent staged-verify on the gemini lane.
    const calls = await handle.db.select().from(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.intent).toBe("staged-verify");
    expect(calls[0]?.lane).toBe("gemini");
  });

  it("reject → marks the row REJECTED as gemini-auto", async () => {
    await seedValid(handle, [
      { targetMaster: "prices", proposed: pricePoint("[v:reject]", "FAS-SMK-001"), confidence: 0.9 },
    ]);

    const report = await autoApproveBatch(deps(handle, verdictStub()));

    expect(report.rejected).toBe(1);
    expect(report.approved).toBe(0);
    const staged = await allStaged(handle);
    expect(staged[0]?.status).toBe("REJECTED");
    expect(staged[0]?.reviewedBy).toBe("gemini-auto");
    expect(report.examples.rejected).toHaveLength(1);
    expect(report.examples.rejected[0]?.id).toBe(staged[0]?.id);
  });

  it("unsure → leaves the row PROPOSED for a human", async () => {
    await seedValid(handle, [
      { targetMaster: "makes", proposed: makeLink("[v:unsure]", "FAS-MCP-001"), confidence: 0.9 },
    ]);

    const report = await autoApproveBatch(deps(handle, verdictStub()));

    expect(report.unsure).toBe(1);
    expect(report.remainingProposed).toBe(1);
    const staged = await allStaged(handle);
    expect(staged[0]?.status).toBe("PROPOSED");
    expect(staged[0]?.reviewedBy).toBeNull();
  });

  it("dryRun → reports the would-be split but writes nothing", async () => {
    await seedValid(handle, [
      { targetMaster: "materials", proposed: materialBundle("[v:approve]", "Zorbex Deluge Actuator Valve 150mm", "SPR-VLV-901"), confidence: 0.9 },
      { targetMaster: "prices", proposed: pricePoint("[v:reject]", "FAS-SMK-001"), confidence: 0.9 },
    ]);
    const matsBefore = (await handle.db.select().from(materials)).length;

    const report = await autoApproveBatch(deps(handle, verdictStub()), { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.processed).toBe(2);
    expect(report.approved).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.remainingProposed).toBe(2); // nothing committed/rejected
    expect(report.costUsd).toBeGreaterThan(0); // cost still tallied

    // No writes: statuses unchanged, no masters, no audit, no llm_calls rows.
    const staged = await allStaged(handle);
    expect(staged.every((r) => r.status === "PROPOSED")).toBe(true);
    expect((await handle.db.select().from(materials)).length).toBe(matsBefore);
    expect(await handle.db.select().from(auditEvents)).toHaveLength(0);
    expect(await handle.db.select().from(llmCalls)).toHaveLength(0);
  });

  it("invalid payload → counts skippedInvalid and leaves the row PROPOSED", async () => {
    const runId = await seedValid(handle, [
      { targetMaster: "prices", proposed: pricePoint("[v:approve]", "FAS-SMK-001"), confidence: 0.9 },
    ]);
    const invalidId = await seedInvalidRow(handle, runId);

    const report = await autoApproveBatch(deps(handle, verdictStub()));

    expect(report.skippedInvalid).toBe(1);
    expect(report.approved).toBe(1); // the valid one still commits
    const staged = await allStaged(handle);
    const invalid = staged.find((r) => r.id === invalidId);
    expect(invalid?.status).toBe("PROPOSED");
    // The skipped row surfaces as a human-review example.
    expect(report.examples.unsure.some((e) => e.id === invalidId)).toBe(true);
  });

  it("commit-throw resilience → a conflicting commit is counted unsure, batch completes", async () => {
    await seedValid(handle, [
      // approve, but the referenced material does not exist → commit throws.
      { targetMaster: "prices", proposed: pricePoint("[v:approve]", "FAS-GONE-999"), confidence: 0.9 },
      // a clean approve to prove the batch carries on past the failure.
      { targetMaster: "materials", proposed: materialBundle("[v:approve]", "Zorbex Deluge Actuator Valve 200mm", "SPR-VLV-902"), confidence: 0.9 },
    ]);

    const report = await autoApproveBatch(deps(handle, verdictStub()));

    expect(report.approved).toBe(1);
    expect(report.unsure).toBe(1); // the throw was absorbed
    expect(report.examples.unsure.some((e) => /commit failed/.test(e.issue))).toBe(true);

    // The conflicting row is left PROPOSED for a human; nothing half-committed.
    const staged = await allStaged(handle);
    const stuck = staged.find((r) => (r.proposed as { materialCode?: string }).materialCode === "FAS-GONE-999");
    expect(stuck?.status).toBe("PROPOSED");
  });

  it("model null → throws a 503 WorkerError upfront", async () => {
    await seedValid(handle, [
      { targetMaster: "prices", proposed: pricePoint("[v:approve]", "FAS-SMK-001"), confidence: 0.9 },
    ]);
    await expect(autoApproveBatch(deps(handle, null))).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/verification model not configured/),
    });
    // Nothing was touched.
    const staged = await allStaged(handle);
    expect(staged.every((r) => r.status === "PROPOSED")).toBe(true);
  });
});

describe("POST /tasks/auto-approve (app level)", () => {
  let handle: DbHandle;
  let appDeps: AppDeps;
  beforeEach(async () => {
    handle = await freshDb();
    appDeps = {
      db: handle.db,
      storage: new LocalStorageAdapter(await tempStorageDir()),
      pdf: new StubPdfRenderer(),
      providers: { email: new StubEmailProvider(), whatsapp: new StubWhatsAppProvider() },
      ingestAi: { model: verdictStub(), embedder: new StubEmbedder() },
    };
  });
  afterEach(async () => {
    await handle.close();
  });

  it("returns a 200 dry-run report over the seeded queue", async () => {
    await seedValid(handle, [
      { targetMaster: "materials", proposed: materialBundle("[v:approve]", "Zorbex Deluge Actuator Valve 300mm", "SPR-VLV-903"), confidence: 0.9 },
      { targetMaster: "prices", proposed: pricePoint("[v:reject]", "FAS-SMK-001"), confidence: 0.9 },
    ]);

    const app = createApp(appDeps);
    const res = await app.request("/tasks/auto-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      approved: number;
      rejected: number;
      dryRun: boolean;
      remainingProposed: number;
    };
    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(2);
    expect(body.approved).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.remainingProposed).toBe(2);

    // Dry run wrote nothing.
    const staged = await allStaged(handle);
    expect(staged.every((r) => r.status === "PROPOSED")).toBe(true);
  });

  it("maps a model-less deployment to HTTP 503", async () => {
    appDeps.ingestAi = { model: null, embedder: new StubEmbedder() };
    const app = createApp(appDeps);
    const res = await app.request("/tasks/auto-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });
});
