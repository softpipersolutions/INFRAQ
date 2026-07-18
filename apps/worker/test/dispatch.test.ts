import type { DbHandle } from "@pebble/db";
import { listAuditForEstimate } from "@pebble/db";
import { dispatches } from "@pebble/db/schema";
import { createEmailProvider, createWhatsAppProvider } from "@pebble/dispatch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchEstimateDocuments } from "../src/dispatch-handler";
import { createLockedEstimate, freshDb } from "./helpers";

describe("dispatchEstimateDocuments", () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it("fans out to email + WhatsApp → 2 dispatches rows + EST_DISPATCHED audit each", async () => {
    const { estimateId } = await createLockedEstimate(handle);

    // No creds in env → both providers resolve to their stubs.
    const providers = {
      email: createEmailProvider({}),
      whatsapp: createWhatsAppProvider({}),
    };

    const results = await dispatchEstimateDocuments(
      { db: handle.db, providers },
      {
        estimateId,
        toEmail: "client@example.com",
        toPhone: "+919811122333",
        subject: "Your Greenberg fire-safety estimate",
        message: "Please find your BOQ attached.",
        documentIds: ["doc-pdf", "doc-xlsx"],
      },
    );

    // One result per channel, both SENT via the stub adapters.
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.channel))).toEqual(new Set(["EMAIL", "WHATSAPP"]));
    expect(results.every((r) => r.result.status === "SENT")).toBe(true);

    // Two outbox rows persisted, carrying the recipient + provider + doc ids.
    const rows = await handle.db.select().from(dispatches);
    expect(rows).toHaveLength(2);
    const email = rows.find((r) => r.channel === "EMAIL");
    const whatsapp = rows.find((r) => r.channel === "WHATSAPP");
    expect(email?.recipient).toBe("client@example.com");
    expect(email?.status).toBe("SENT");
    expect(email?.provider).toBe("stub");
    expect(email?.documentIds).toEqual(["doc-pdf", "doc-xlsx"]);
    expect(whatsapp?.recipient).toBe("+919811122333");
    expect(whatsapp?.providerMessageId).toBeTruthy();

    // One EST_DISPATCHED audit event per channel.
    const audit = await listAuditForEstimate(handle.db, estimateId);
    const dispatched = audit.filter((e) => e.eventType === "EST_DISPATCHED");
    expect(dispatched).toHaveLength(2);
  });

  it("dispatches email only when no phone is supplied", async () => {
    const { estimateId } = await createLockedEstimate(handle);
    const providers = {
      email: createEmailProvider({}),
      whatsapp: createWhatsAppProvider({}),
    };

    const results = await dispatchEstimateDocuments(
      { db: handle.db, providers },
      {
        estimateId,
        toEmail: "solo@example.com",
        subject: "Estimate",
        message: "Body",
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toBe("EMAIL");
    const rows = await handle.db.select().from(dispatches);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.documentIds).toEqual([]);
  });
});
