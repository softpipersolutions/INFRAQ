import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "../src/storage";
import { tempStorageDir } from "./helpers";

describe("LocalStorageAdapter", () => {
  it("put → read round trips the exact bytes", async () => {
    const storage = new LocalStorageAdapter(await tempStorageDir());
    const bytes = Buffer.from("Format A BOQ PDF bytes — round trip");

    const { uri } = await storage.put("estimates/GBE-EST-2026-001/v1/doc.pdf", bytes, "application/pdf");
    expect(uri.startsWith("file://")).toBe(true);

    const roundTripped = await storage.read(uri);
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it("sha256 is stable and matches node:crypto for the stored bytes", async () => {
    const storage = new LocalStorageAdapter(await tempStorageDir());
    const bytes = Buffer.from("deterministic content for hashing");
    const expected = createHash("sha256").update(bytes).digest("hex");

    const first = await storage.put("a/b/c.xlsx", bytes, "application/octet-stream");
    const second = await storage.put("a/b/c.xlsx", bytes, "application/octet-stream");

    expect(first.sha256).toBe(expected);
    expect(second.sha256).toBe(expected);
  });

  it("signedUrl returns the file:// locator for local storage", async () => {
    const storage = new LocalStorageAdapter(await tempStorageDir());
    const { uri } = await storage.put("x/y.pdf", Buffer.from("x"), "application/pdf");
    await expect(storage.signedUrl(uri, 3600)).resolves.toBe(uri);
  });
});
