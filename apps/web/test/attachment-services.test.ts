import type { SkillsLane } from "@pebble/ai";
import {
  createDb,
  getChatAttachment,
  getOrCreateChatSession,
  insertChatAttachment,
  listSessionAttachments,
  migrateDb,
  seedDatabase,
  upsertUser,
  type AppUser,
  type Db,
  type DbHandle,
} from "@pebble/db";
import type { PutResult, StorageAdapter } from "@pebble/worker";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAttachmentServices } from "../src/server/attachment-services";

/**
 * `AttachmentServices` over an in-memory PGlite db + an in-memory storage stub
 * + a stubbed skills lane. Covers list, read (txt + xlsx paths), owner/session
 * scoping, and generate_file storing a GENERATED attachment.
 */

/** Content-addressed in-memory storage — enough for the get/put paths used here. */
class MemoryStorage implements StorageAdapter {
  private readonly map = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer | Uint8Array): Promise<PutResult> {
    const uri = `mem://${key}`;
    this.map.set(uri, Buffer.from(bytes));
    return { uri, sha256: "stub" };
  }
  async signedUrl(uri: string): Promise<string> {
    return uri;
  }
  async get(uri: string): Promise<Buffer> {
    const found = this.map.get(uri);
    if (!found) throw new Error(`no object at ${uri}`);
    return found;
  }
  keyToUri(key: string): string {
    return `mem://${key}`;
  }
}

const OWNER: AppUser = {
  firebaseUid: "att-owner",
  email: "owner@greenberg.test",
  displayName: "Owner",
  role: "estimator",
  active: true,
};
const OTHER: AppUser = {
  firebaseUid: "att-other",
  email: "other2@greenberg.test",
  displayName: "Other",
  role: "estimator",
  active: true,
};

async function buildXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S1");
  ws.addRow(["k", "v"]);
  ws.addRow(["material", 42]);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe("AttachmentServices", () => {
  let handle: DbHandle;
  let db: Db;
  let storage: MemoryStorage;

  beforeAll(async () => {
    handle = await createDb({ pglite: true, pgliteDir: "memory://" });
    await migrateDb(handle);
    await seedDatabase(handle.db);
    db = handle.db as unknown as Db;
    storage = new MemoryStorage();
    await upsertUser(db, OWNER);
    await upsertUser(db, OTHER);
    await getOrCreateChatSession(db, { sessionId: "att-sess", userId: OWNER.firebaseUid });
    await getOrCreateChatSession(db, { sessionId: "other-sess", userId: OTHER.firebaseUid });
  });

  afterAll(async () => {
    await handle.close();
  });

  /** Store bytes + insert a chat_attachments row, returning its id. */
  async function seedAttachment(args: {
    sessionId: string;
    userId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
    status?: string;
  }): Promise<string> {
    const { uri } = await storage.put(`chat/${args.filename}-${Math.random()}`, args.bytes);
    const row = await insertChatAttachment(db, {
      sessionId: args.sessionId,
      userId: args.userId,
      filename: args.filename,
      mediaType: args.mediaType,
      sizeBytes: args.bytes.byteLength,
      sha256: `sha-${args.filename}`,
      storageUri: uri,
      status: args.status ?? "READY",
    });
    return row.id;
  }

  function services(userId: string, lane: SkillsLane | null = null) {
    // The concrete impl always provides the (interface-optional) office methods.
    return createAttachmentServices({ db, storage, userId, skillsLane: lane }) as ReturnType<
      typeof createAttachmentServices
    > &
      Required<Pick<ReturnType<typeof createAttachmentServices>, "generateFile" | "analyzeOfficeFile">>;
  }

  it("listAttachments returns the session's uploads, owner-scoped", async () => {
    await seedAttachment({ sessionId: "att-sess", userId: OWNER.firebaseUid, filename: "a.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("hi") });
    const list = await services(OWNER.firebaseUid).listAttachments("att-sess");
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({ filename: "a.txt", mediaType: "text/plain", status: "READY" });

    // A different user sees none of the owner's session files.
    const foreign = await services(OTHER.firebaseUid).listAttachments("att-sess");
    expect(foreign).toEqual([]);
  });

  it("readAttachment returns verbatim text for a .txt", async () => {
    const id = await seedAttachment({ sessionId: "att-sess", userId: OWNER.firebaseUid, filename: "notes.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("plain body") });
    const r = await services(OWNER.firebaseUid).readAttachment("att-sess", id);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("plain body");
  });

  it("readAttachment renders an xlsx as CSV", async () => {
    const id = await seedAttachment({
      sessionId: "att-sess",
      userId: OWNER.firebaseUid,
      filename: "sheet.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: await buildXlsx(),
    });
    const r = await services(OWNER.firebaseUid).readAttachment("att-sess", id);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("k,v");
    expect(r.text).toContain("material,42");
  });

  it("readAttachment refuses a foreign attachment (owner scoping)", async () => {
    const id = await seedAttachment({ sessionId: "att-sess", userId: OWNER.firebaseUid, filename: "secret.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("secret") });
    const r = await services(OTHER.firebaseUid).readAttachment("att-sess", id);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/not found/i);
  });

  it("readAttachment refuses an attachment from a different session", async () => {
    const id = await seedAttachment({ sessionId: "att-sess", userId: OWNER.firebaseUid, filename: "cross.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("x") });
    // Same owner, but a different (owned) session id → still refused (session-scoped).
    await getOrCreateChatSession(db, { sessionId: "owner-sess-2", userId: OWNER.firebaseUid });
    const r = await services(OWNER.firebaseUid).readAttachment("owner-sess-2", id);
    expect(r.ok).toBe(false);
  });

  it("generateFile stores a GENERATED attachment via the skills lane", async () => {
    const stubLane = {
      generateOfficeFile: async () => ({
        bytes: new Uint8Array([80, 75, 3, 4]),
        filename: "draft.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    } as unknown as SkillsLane;

    const result = await services(OWNER.firebaseUid, stubLane).generateFile("att-sess", "make a sheet", "xlsx");
    if (!result.ok) throw new Error(`generateFile failed: ${result.error}`);
    expect(result.ok).toBe(true);
    expect(result.draft).toBe(true);
    expect(result.filename).toBe("draft.xlsx");

    // The row exists, owner-scoped, with status GENERATED.
    const row = await getChatAttachment(db, { id: result.attachmentId!, userId: OWNER.firebaseUid });
    expect(row?.status).toBe("GENERATED");
    // And it is listed under the session.
    const list = await listSessionAttachments(db, { sessionId: "att-sess", userId: OWNER.firebaseUid });
    expect(list.some((a) => a.id === result.attachmentId)).toBe(true);
  });

  it("generateFile returns a failure string (never throws) when the lane errors", async () => {
    const failing = {
      generateOfficeFile: async () => {
        throw new Error("container blew up");
      },
    } as unknown as SkillsLane;
    const result = await services(OWNER.firebaseUid, failing).generateFile("att-sess", "x", "docx");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("container blew up");
  });

  it("analyze/generate report a clear message when the lane is disabled (null)", async () => {
    const svc = services(OWNER.firebaseUid, null);
    const gen = await svc.generateFile("att-sess", "x", "pptx");
    expect(gen.ok).toBe(false);
    expect(gen.error).toMatch(/not enabled/i);
  });
});
