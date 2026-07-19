/**
 * Temporary WP6 smoke-test helper — NOT part of the shipped app.
 *
 * Seeds a fresh PGlite data dir (masters + dev admin via seedDatabase) and
 * stages one "materials" proposal so the ingestion queue / dashboard / RAG
 * pages have something to render for a manual dev-mode sanity pass. Run
 * BEFORE starting the web server against the same PGLITE_DIR (PGlite's file
 * backend is single-process) — the server's own SEED_ON_BOOT path is a no-op
 * once masters already exist.
 */
import {
  createDb,
  ensureDevUser,
  insertStagedRecords,
  migrateDb,
  registerSourceDocument,
  seedDatabase,
  startExtractionRun,
} from "@pebble/db";

async function main() {
  const pgliteDir = process.env.PGLITE_DIR;
  if (!pgliteDir) throw new Error("PGLITE_DIR env var required");

  const handle = await createDb({ pglite: true, pgliteDir });
  await migrateDb(handle);
  const db = handle.db as Parameters<typeof seedDatabase>[0];
  await seedDatabase(db);
  await ensureDevUser(db);

  const { id: docId } = await registerSourceDocument(db, {
    filename: "GBE-2024-0042-Rev1.pdf",
    storageUri: "file:///tmp/wp6-smoke-does-not-exist/GBE-2024-0042-Rev1.pdf",
    docType: "PROPOSAL",
    fileRef: "GBE-2024-0042",
    docDate: new Date("2024-06-01T00:00:00.000Z"),
  });
  const runId = await startExtractionRun(db, {
    sourceDocumentId: docId,
    model: "gemini-2.5-pro",
    promptVersion: "extract-v3",
  });
  await insertStagedRecords(db, runId, [
    {
      targetMaster: "materials",
      confidence: 0.93,
      sourceLocator: { page: 4 },
      proposed: {
        payloadVersion: 1,
        material: {
          materialCode: "FAS-DET-960",
          materialName: "Addressable Smoke Detector Photoelectric Type",
          systemType: "FAS",
          category: "Detector",
          unitOfMeasure: { raw: "Nos", normalized: "No." },
          specSummary: "IS 2189 compliant, addressable loop",
        },
        make: { brandName: { raw: "Honeywell", normalized: "Honeywell" }, tier: "Premium" },
        price: {
          sellRupees: 2650,
          buyRupees: 2050,
          rateKind: "SUPPLY",
          validFromISO: "2024-06-01T00:00:00.000Z",
        },
        installRate: { rupees: 950, unit: "Per No." },
        sourceText: "Addressable smoke detector supply as per BOQ item 4.2",
      },
    },
  ]);

  await handle.close();
  console.log(JSON.stringify({ ok: true, docId, runId }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
