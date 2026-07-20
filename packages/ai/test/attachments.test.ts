import { describe, expect, it } from "vitest";
import {
  attachmentsToolset,
  composeAgent,
  type AttachmentServices,
  type SystemBlock,
} from "../src/index";

/**
 * The module-agnostic attachments toolset (WP8): the re-read tools are always
 * present; the Office analyze/generate tools appear ONLY when `skillsEnabled`,
 * so with the flag off they cost nothing. Also verifies it composes cleanly
 * beside another module (no tool-name collision) and carries an empty policy.
 */

const digestBlock: SystemBlock = {
  role: "system",
  content: "# masters",
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
};

function stubServices(over: Partial<AttachmentServices> = {}): AttachmentServices {
  return {
    listAttachments: async () => [
      { attachmentId: "a1", filename: "spec.pdf", mediaType: "application/pdf", sizeBytes: 100, pageCount: 2, status: "READY" },
    ],
    readAttachment: async (_s, id) => ({ ok: true, attachmentId: id, filename: "spec.pdf", mediaType: "application/pdf", text: "hello" }),
    ...over,
  };
}

describe("attachmentsToolset — tool presence by flag", () => {
  it("flag OFF: only the re-read tools exist (no Office tools)", () => {
    const mod = attachmentsToolset(stubServices(), { sessionId: "s1", skillsEnabled: false });
    expect(Object.keys(mod.tools).sort()).toEqual(["list_attachments", "read_attachment"]);
    expect(mod.tools.analyze_office_file).toBeUndefined();
    expect(mod.tools.generate_file).toBeUndefined();
  });

  it("flag ON: the two Office tools are added", () => {
    const mod = attachmentsToolset(stubServices(), { sessionId: "s1", skillsEnabled: true });
    expect(Object.keys(mod.tools).sort()).toEqual([
      "analyze_office_file",
      "generate_file",
      "list_attachments",
      "read_attachment",
    ]);
  });

  it("default (no skillsEnabled) is flag OFF", () => {
    const mod = attachmentsToolset(stubServices(), { sessionId: "s1" });
    expect(mod.tools.generate_file).toBeUndefined();
  });

  it("has an empty (no confirm/human-only) policy", () => {
    const mod = attachmentsToolset(stubServices(), { sessionId: "s1" });
    expect(mod.policy).toEqual({ confirmRequired: [], humanOnly: [] });
  });

  it("generate_file's description names the DRAFT / not-official contract", () => {
    const mod = attachmentsToolset(stubServices(), { sessionId: "s1", skillsEnabled: true });
    const desc = (mod.tools.generate_file as { description?: string }).description ?? "";
    expect(desc).toMatch(/DRAFT/);
    expect(desc.toLowerCase()).toContain("never an official");
  });
});

describe("attachmentsToolset — bound session + delegation", () => {
  it("list_attachments injects the bound sessionId (not model-supplied)", async () => {
    let seen: string | null = null;
    const mod = attachmentsToolset(
      stubServices({
        listAttachments: async (sessionId) => {
          seen = sessionId;
          return [];
        },
      }),
      { sessionId: "bound-session" },
    );
    const exec = (mod.tools.list_attachments as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    await exec({}, {});
    expect(seen).toBe("bound-session");
  });

  it("read_attachment passes the attachmentId through to the service", async () => {
    let seenId: string | null = null;
    const mod = attachmentsToolset(
      stubServices({
        readAttachment: async (_s, id) => {
          seenId = id;
          return { ok: true, attachmentId: id, filename: "x", mediaType: "text/plain", text: "y" };
        },
      }),
      { sessionId: "s1" },
    );
    const exec = (mod.tools.read_attachment as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    await exec({ attachmentId: "a42" }, {});
    expect(seenId).toBe("a42");
  });
});

describe("attachmentsToolset — composes beside another module", () => {
  it("no tool-name collision when composed with a Module-02-like toolset", async () => {
    const other = {
      id: "module02",
      title: "M02",
      promptFragment: "m02",
      tools: { lookup_material: { description: "x", inputSchema: {} as never, execute: async () => null } as never },
      policy: { confirmRequired: ["create_enquiry"], humanOnly: ["approve_estimate"] },
    };
    const comp = await composeAgent({
      persona: "P",
      modules: [other, attachmentsToolset(stubServices(), { sessionId: "s1", skillsEnabled: true })],
      digestBlock,
      turn: { sessionId: "s1", userId: "u1", userRole: "estimator" },
    });
    // Bare (un-prefixed) names since there is no collision.
    expect(comp.tools.list_attachments).toBeDefined();
    expect(comp.tools.generate_file).toBeDefined();
    expect(comp.tools.lookup_material).toBeDefined();
  });
});
