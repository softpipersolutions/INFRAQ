import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter, parseGsUri } from "../src/storage";
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

  it("get() round-trips the exact bytes (delegates to read())", async () => {
    const storage = new LocalStorageAdapter(await tempStorageDir());
    const bytes = Buffer.from("ingestion source PDF bytes — get() round trip");
    const { uri } = await storage.put("sources/FF-01/doc.pdf", bytes, "application/pdf");

    const fetched = await storage.get(uri);
    expect(fetched.equals(bytes)).toBe(true);
  });
});

describe("parseGsUri", () => {
  it("splits a gs:// uri into bucket and key", () => {
    expect(parseGsUri("gs://pebble-ingestion/sources/FF-01/doc.pdf")).toEqual({
      bucket: "pebble-ingestion",
      key: "sources/FF-01/doc.pdf",
    });
  });

  it("preserves nested path segments in the key", () => {
    expect(parseGsUri("gs://my-bucket/a/b/c/file.xlsx")).toEqual({
      bucket: "my-bucket",
      key: "a/b/c/file.xlsx",
    });
  });

  it("throws on a non-gs:// uri", () => {
    expect(() => parseGsUri("file:///tmp/x.pdf")).toThrow();
    expect(() => parseGsUri("not-a-uri")).toThrow();
  });
});
