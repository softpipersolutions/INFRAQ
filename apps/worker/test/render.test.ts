import type { DbHandle } from "@pebble/db";
import { listAuditForEstimate } from "@pebble/db";
import { generatedDocuments } from "@pebble/db/schema";
import { StubEmailProvider, StubWhatsAppProvider } from "@pebble/dispatch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/app";
import { StubPdfRenderer } from "../src/pdf";
import { renderEstimateDocuments } from "../src/render";
import { LocalStorageAdapter } from "../src/storage";
import { createLockedEstimate, freshDb, makeCurrentVersionWorking, tempStorageDir } from "./helpers";

describe("renderEstimateDocuments", () => {
  let handle: DbHandle;
  let deps: AppDeps;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    handle = await freshDb();
    storage = new LocalStorageAdapter(await tempStorageDir());
    deps = {
      db: handle.db,
      storage,
      pdf: new StubPdfRenderer(),
      providers: { email: new StubEmailProvider(), whatsapp: new StubWhatsAppProvider() },
    };
  });

  afterEach(async () => {
    await handle.close();
  });

  it("renders a LOCKED version → 2 generated_documents rows + OUTPUT_GENERATED audit", async () => {
    const { estimateId, versionId } = await createLockedEstimate(handle);

    const result = await renderEstimateDocuments(deps, { estimateId, revision: "R0" });

    // Result shape: PDF + XLSX, each with an id/uri/sha256.
    expect(result.pdf.uri.startsWith("file://")).toBe(true);
    expect(result.xlsx.uri.startsWith("file://")).toBe(true);
    expect(result.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.xlsx.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pdf.id).not.toBe(result.xlsx.id);

    // Two document rows persisted for this version (PDF + XLSX, format "A").
    const docs = await handle.db.select().from(generatedDocuments);
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.estimateVersionId === versionId)).toBe(true);
    expect(docs.every((d) => d.format === "A")).toBe(true);
    expect(new Set(docs.map((d) => d.kind))).toEqual(new Set(["PDF", "XLSX"]));

    // The rendered bytes actually landed in storage and match the recorded uri.
    const pdfBytes = await storage.read(result.pdf.uri);
    expect(pdfBytes.toString("utf8").startsWith("%PDF")).toBe(true);

    // Exactly one OUTPUT_GENERATED audit event was appended.
    const audit = await listAuditForEstimate(handle.db, estimateId);
    const outputEvents = audit.filter((e) => e.eventType === "OUTPUT_GENERATED");
    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0]?.version).toBe(1);
  });

  it("refuses to render a non-LOCKED (WORKING) version", async () => {
    const { estimateId } = await createLockedEstimate(handle);
    await makeCurrentVersionWorking(handle, estimateId);

    // Direct handler: throws a 400 WorkerError.
    await expect(renderEstimateDocuments(deps, { estimateId })).rejects.toMatchObject({
      status: 400,
    });

    // No documents were written on the failed render.
    const docs = await handle.db.select().from(generatedDocuments);
    expect(docs).toHaveLength(0);
  });

  it("POST /tasks/render maps the non-LOCKED guard to HTTP 400", async () => {
    const { estimateId } = await createLockedEstimate(handle);
    await makeCurrentVersionWorking(handle, estimateId);
    const app = createApp(deps);

    const res = await app.request("/tasks/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ estimateId }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tasks/render renders the current LOCKED version and returns the result", async () => {
    const { estimateId } = await createLockedEstimate(handle);
    const app = createApp(deps);

    const res = await app.request("/tasks/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ estimateId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pdf: { uri: string }; xlsx: { uri: string } };
    expect(body.pdf.uri.startsWith("file://")).toBe(true);
    expect(body.xlsx.uri.startsWith("file://")).toBe(true);
  });
});
