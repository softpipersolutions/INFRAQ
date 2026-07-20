import { describe, expect, it } from "vitest";
import {
  createSkillsLaneFromEnv,
  SKILLS_LANE_BETAS,
  SkillsLane,
  SkillsLaneError,
  skillsLaneEnabled,
  type FetchLike,
} from "../src/skills-lane";

/**
 * Skills-lane plumbing over a STUBBED fetch — no live Anthropic key, no network.
 * Verifies the Files-API upload, the analyze + generate happy paths (including
 * the upload→messages→download chain and the file-id extraction), the error
 * path surfacing a `SkillsLaneError`, and the env flag gating.
 */

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch stub: routes by URL suffix to canned JSON/binary responses, recording calls. */
function stubFetch(
  routes: Record<string, () => Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const [suffix, make] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return make();
    }
    throw new Error(`no stub route for ${url}`);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lane(fetchImpl: FetchLike): SkillsLane {
  return new SkillsLane({ apiKey: "sk-test", model: "claude-test", fetchImpl });
}

describe("SkillsLane.uploadToFilesApi", () => {
  it("POSTs to /v1/files with the betas and returns the file id", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/v1/files": () => jsonResponse({ id: "file_123", type: "file" }),
    });
    const result = await lane(fetchImpl).uploadToFilesApi(new Uint8Array([1, 2, 3]), "data.xlsx", "application/vnd.ms-excel");
    expect(result.fileId).toBe("file_123");

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-beta"]).toBe(SKILLS_LANE_BETAS);
  });

  it("throws SkillsLaneError when the API returns an error", async () => {
    const { fetchImpl } = stubFetch({
      "/v1/files": () => jsonResponse({ error: { message: "bad file" } }, 400),
    });
    await expect(lane(fetchImpl).uploadToFilesApi(new Uint8Array([1]), "x.xlsx", "application/octet-stream")).rejects.toBeInstanceOf(
      SkillsLaneError,
    );
  });
});

describe("SkillsLane.analyzeOfficeFile", () => {
  it("uploads bytes then runs the container messages call and returns the text", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/v1/files": () => jsonResponse({ id: "file_up" }),
      "/v1/messages": () =>
        jsonResponse({
          content: [
            { type: "text", text: "The sheet has 3 line items totalling ₹120,000." },
          ],
        }),
    });
    const text = await lane(fetchImpl).analyzeOfficeFile({
      bytes: new Uint8Array([9, 9]),
      filename: "boq.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      instruction: "Summarise the sheet.",
    });
    expect(text).toContain("3 line items");
    // Upload first, then messages.
    expect(calls[0]!.url).toContain("/v1/files");
    expect(calls[1]!.url).toContain("/v1/messages");
    // The container_upload block references the uploaded id.
    const body = JSON.parse(calls[1]!.init!.body as string);
    expect(body.messages[0].content[0]).toEqual({ type: "container_upload", file_id: "file_up" });
  });

  it("skips the upload when a fileId is supplied", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/v1/messages": () => jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    });
    await lane(fetchImpl).analyzeOfficeFile({
      fileId: "file_existing",
      filename: "d.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      instruction: "read it",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/messages");
  });

  it("throws when the analysis returns no text", async () => {
    const { fetchImpl } = stubFetch({
      "/v1/messages": () => jsonResponse({ content: [] }),
    });
    await expect(
      lane(fetchImpl).analyzeOfficeFile({ fileId: "f", filename: "x.xlsx", mediaType: "x", instruction: "y" }),
    ).rejects.toBeInstanceOf(SkillsLaneError);
  });
});

describe("SkillsLane.generateOfficeFile", () => {
  it("runs the skill, extracts the produced file id, downloads it and returns bytes", async () => {
    const produced = new Uint8Array([80, 75, 3, 4]); // "PK.." — a zip/xlsx magic
    const { fetchImpl, calls } = stubFetch({
      "/v1/messages": () =>
        jsonResponse({
          content: [
            { type: "text", text: "Here is your draft spreadsheet." },
            {
              type: "code_execution_tool_result",
              content: { content: [{ type: "code_execution_output", file_id: "file_out" }] },
            },
          ],
        }),
      "/v1/files/file_out/content": () =>
        new Response(produced, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    });

    const result = await lane(fetchImpl).generateOfficeFile({
      instruction: "Build a 3-row quote sheet.",
      format: "xlsx",
      filenameStem: "quote-draft",
    });
    expect(result.filename).toBe("quote-draft.xlsx");
    expect(result.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect([...result.bytes]).toEqual([80, 75, 3, 4]);
    expect(calls[calls.length - 1]!.url).toContain("/v1/files/file_out/content");
  });

  it("throws when no file was produced", async () => {
    const { fetchImpl } = stubFetch({
      "/v1/messages": () => jsonResponse({ content: [{ type: "text", text: "I couldn't." }] }),
    });
    await expect(
      lane(fetchImpl).generateOfficeFile({ instruction: "x", format: "docx" }),
    ).rejects.toBeInstanceOf(SkillsLaneError);
  });
});

describe("createSkillsLaneFromEnv / skillsLaneEnabled", () => {
  it("returns null when the flag is off", () => {
    expect(createSkillsLaneFromEnv({ ANTHROPIC_API_KEY: "k" }, { model: "m" })).toBeNull();
    expect(skillsLaneEnabled({})).toBe(false);
  });

  it("returns null when the flag is on but no key is set", () => {
    expect(createSkillsLaneFromEnv({ PEBBLE_SKILLS_LANE: "1" }, { model: "m" })).toBeNull();
  });

  it("builds a lane when the flag is on and a key is set", () => {
    const built = createSkillsLaneFromEnv(
      { PEBBLE_SKILLS_LANE: "1", ANTHROPIC_API_KEY: "k" },
      { model: "m" },
    );
    expect(built).toBeInstanceOf(SkillsLane);
    expect(skillsLaneEnabled({ PEBBLE_SKILLS_LANE: "1" })).toBe(true);
  });
});
