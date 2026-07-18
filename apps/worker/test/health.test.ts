import { StubEmailProvider, StubWhatsAppProvider } from "@pebble/dispatch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@pebble/db";
import { createApp } from "../src/app";
import { StubPdfRenderer } from "../src/pdf";
import { LocalStorageAdapter } from "../src/storage";
import { freshDb, tempStorageDir } from "./helpers";

describe("worker app", () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await freshDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it("GET /health returns { ok: true }", async () => {
    const app = createApp({
      db: handle.db,
      storage: new LocalStorageAdapter(await tempStorageDir()),
      pdf: new StubPdfRenderer(),
      providers: { email: new StubEmailProvider(), whatsapp: new StubWhatsAppProvider() },
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
