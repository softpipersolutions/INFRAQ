import type { Db } from "@pebble/db";
import { appendAudit, getEnquiry, getVersionWithLines, newUlid } from "@pebble/db";
import { generatedDocuments } from "@pebble/db/schema";
import {
  buildFormatAInput,
  formatAWorkbookBuffer,
  renderFormatAHtml,
} from "@pebble/documents";
import type { EstimateTotals } from "@pebble/shared";
import { WorkerError } from "./errors";
import type { HtmlToPdf } from "./pdf";
import type { StorageAdapter } from "./storage";

/**
 * Render + persist the Format A outputs (PDF + XLSX) for one estimate version.
 *
 * The invariants this handler protects (PLAN §4.6):
 *   - **Only LOCKED versions render.** A WORKING draft is still mutable, so a
 *     document rendered from it could disagree with what is finally approved.
 *     We refuse rather than emit a document that can't be reproduced.
 *   - **Money is never recomputed here.** The engine already wrote the
 *     authoritative integer-paise totals onto the version row; we pass them
 *     through `buildFormatAInput` verbatim.
 *   - **Storage first, then one DB write.** Bytes are uploaded (network IO)
 *     before opening the transaction, so the `generated_documents` rows +
 *     `OUTPUT_GENERATED` audit event commit together and never reference an
 *     object that failed to upload.
 */

export interface RenderDeps {
  db: Db;
  storage: StorageAdapter;
  pdf: HtmlToPdf;
}

export interface RenderArgs {
  estimateId: string;
  /** Defaults to the estimate's current version. */
  versionNo?: number;
  /** Revision label printed on the document (e.g. `"R0"`, `"R2"`). */
  revision?: string;
  /** Issue date (ISO). Defaults to today inside `buildFormatAInput`. */
  dateISO?: string;
  /** Audit actor; defaults to `"worker"`. */
  actor?: string;
}

/** One stored+recorded document within a render result. */
export interface RenderedDoc {
  /** `generated_documents.id` (ULID). */
  id: string;
  /** Backend uri (`file://` / `gs://`). */
  uri: string;
  /** Hex sha256 of the stored bytes. */
  sha256: string;
}

export interface RenderResult {
  pdf: RenderedDoc;
  xlsx: RenderedDoc;
}

/** Storage key for a version's document, namespaced by estimate + version. */
function documentKey(estimateId: string, versionNo: number, ext: "pdf" | "xlsx"): string {
  return `estimates/${estimateId}/v${versionNo}/${estimateId}.${ext}`;
}

export async function renderEstimateDocuments(
  deps: RenderDeps,
  args: RenderArgs,
): Promise<RenderResult> {
  const { db, storage, pdf } = deps;
  const actor = args.actor ?? "worker";

  // 1. Load the version (+ estimate + lines).
  const loaded = await getVersionWithLines(db, args.estimateId, args.versionNo);
  if (!loaded) {
    throw new WorkerError(
      `Estimate ${args.estimateId}${args.versionNo ? ` v${args.versionNo}` : ""} not found`,
      404,
    );
  }
  const { estimate, version, lines } = loaded;

  // 2. Guard: refuse to render a mutable draft.
  if (version.state !== "LOCKED") {
    throw new WorkerError(
      `Version ${version.versionNo} of ${args.estimateId} is ${version.state}; only LOCKED versions can be rendered`,
      400,
    );
  }

  // 3. Load the originating enquiry for the project/client header block.
  const enquiry = await getEnquiry(db, estimate.enquiryId);
  if (!enquiry) {
    throw new WorkerError(`Enquiry ${estimate.enquiryId} for ${args.estimateId} not found`, 404);
  }

  // 4. Assemble the immutable Format A input. Totals are lifted straight off the
  //    persisted version row — no arithmetic in the documents/worker layer.
  const totals: EstimateTotals = {
    totalSupplyPaise: version.totalSupplyPaise,
    totalInstallPaise: version.totalInstallPaise,
    totalSitcPaise: version.totalSitcPaise,
    gstPaise: version.gstPaise,
    grandTotalPaise: version.grandTotalPaise,
    blendedRatio: version.blendedRatio,
  };
  const input = buildFormatAInput({
    estimateId: estimate.estimateId,
    revision: args.revision,
    dateISO: args.dateISO,
    project: {
      clientName: enquiry.clientName,
      projectName: enquiry.projectName,
      clientEmail: enquiry.clientEmail,
      clientPhone: enquiry.clientPhone,
      buildingType: enquiry.buildingType,
      applicableStandard: enquiry.applicableStandard,
    },
    lines,
    totals,
    blendedRatio: version.blendedRatio,
    sitcStatus: estimate.sitcStatus,
  });

  // 5. Render both artifacts from the one input.
  const html = renderFormatAHtml(input);
  const [pdfBytes, xlsxBytes] = await Promise.all([pdf.render(html), formatAWorkbookBuffer(input)]);

  // 6. Upload (outside the transaction — this is network IO).
  const [pdfStored, xlsxStored] = await Promise.all([
    storage.put(
      documentKey(estimate.estimateId, version.versionNo, "pdf"),
      pdfBytes,
      "application/pdf",
    ),
    storage.put(
      documentKey(estimate.estimateId, version.versionNo, "xlsx"),
      xlsxBytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  ]);

  // 7. Record both documents + the audit event in one transaction.
  const pdfId = newUlid();
  const xlsxId = newUlid();
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(generatedDocuments).values([
      {
        id: pdfId,
        estimateVersionId: version.id,
        format: "A",
        kind: "PDF",
        storageUri: pdfStored.uri,
        sha256: pdfStored.sha256,
        generatedBy: actor,
      },
      {
        id: xlsxId,
        estimateVersionId: version.id,
        format: "A",
        kind: "XLSX",
        storageUri: xlsxStored.uri,
        sha256: xlsxStored.sha256,
        generatedBy: actor,
      },
    ]);

    await appendAudit(tx, {
      eventType: "OUTPUT_GENERATED",
      actor,
      estimateId: estimate.estimateId,
      version: version.versionNo,
      payload: {
        versionNo: version.versionNo,
        documents: [
          { id: pdfId, kind: "PDF", uri: pdfStored.uri, sha256: pdfStored.sha256 },
          { id: xlsxId, kind: "XLSX", uri: xlsxStored.uri, sha256: xlsxStored.sha256 },
        ],
      },
    });
  });

  return {
    pdf: { id: pdfId, uri: pdfStored.uri, sha256: pdfStored.sha256 },
    xlsx: { id: xlsxId, uri: xlsxStored.uri, sha256: xlsxStored.sha256 },
  };
}
