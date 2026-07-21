import { createHash } from "node:crypto";
import { getOrCreateChatSession, insertChatAttachment } from "@pebble/db";
import { attachmentStorageKey } from "../../src/server/chat-attachments";
import {
  checkNoInventedNumbers,
  getDigestText,
  getPromptConstantsText,
  type CaseResult,
  type ConversationScenario,
  type EvalCtx,
} from "../harness";

/**
 * Case 10 (WP14) — a file-analysis turn. Seeds a small fixture CSV through the
 * SAME storage + `insertChatAttachment` path the upload route uses
 * (`apps/web/src/server/chat-attachments.ts#attachmentStorageKey`, mirroring
 * `apps/web/test/attachment-services.test.ts`), then runs a turn with
 * `attachmentIds` set. A `text/csv` attachment is classified `text`
 * (`chat-attachment-turn.ts#classifyAttachment`) and gets embedded verbatim as
 * a fenced block on the current user message — no `read_attachment` tool call
 * is needed for the model to see it, so this exercises the pre-flight
 * cost-guard + embed path, not the re-read tool. Asserts the reply names the
 * materials/quantities the CSV actually contains and invents no OTHER figures
 * (reusing the happy-path no-invented-numbers matcher, with the CSV's own text
 * added to the haystack).
 */

const CSV_FILENAME = "materials-list.csv";
const CSV_CONTENT = ["material,quantity,unit", "Smoke Detector,45,nos", "Hydrant Valve,12,nos", "FAS Cable,850,m", ""].join(
  "\n",
);

const QUESTION = "What's in this file? Summarize the materials and their quantities.";

async function run(ctx: EvalCtx): Promise<CaseResult> {
  const notes: string[] = [];
  const sessionId = ctx.makeSession();
  await getOrCreateChatSession(ctx.db, { sessionId, userId: ctx.user.firebaseUid });

  const bytes = new TextEncoder().encode(CSV_CONTENT);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = attachmentStorageKey(ctx.user.firebaseUid, sha256, CSV_FILENAME);
  const { uri } = await ctx.storage.put(key, bytes, "text/csv");
  const attachment = await insertChatAttachment(ctx.db, {
    sessionId,
    userId: ctx.user.firebaseUid,
    filename: CSV_FILENAME,
    mediaType: "text/csv",
    sizeBytes: bytes.byteLength,
    sha256,
    storageUri: uri,
    status: "READY",
  });
  notes.push(`seeded attachment ${attachment.id} (${CSV_FILENAME}, ${bytes.byteLength} bytes) at ${uri}`);

  const turn = await ctx.sendTurn(sessionId, QUESTION, { attachmentIds: [attachment.id] });

  const mentionsSmokeDetector = /smoke detector/i.test(turn.text) && /\b45\b/.test(turn.text);
  const mentionsHydrantValve = /hydrant valve/i.test(turn.text) && /\b12\b/.test(turn.text);
  const mentionsFasCable = /(fas cable|cable)/i.test(turn.text) && /\b850\b/.test(turn.text);
  notes.push(mentionsSmokeDetector ? "reply names Smoke Detector / 45" : "reply MISSING Smoke Detector / 45");
  notes.push(mentionsHydrantValve ? "reply names Hydrant Valve / 12" : "reply MISSING Hydrant Valve / 12");
  notes.push(mentionsFasCable ? "reply names FAS Cable / 850" : "reply MISSING FAS Cable / 850");

  const noAttachmentError = !turn.parts.some((p) => p.type === "error") && turn.response.status === 200;
  notes.push(noAttachmentError ? "turn completed without error (attachment accepted)" : `turn FAILED (status ${turn.response.status})`);

  // No-invented-numbers: every ₹/decimal/large-whole-number token in the reply
  // must trace to the CSV's own content, the question, the digest, or the
  // persona/module fragments (same matcher as happy-path/explain-walkthrough).
  const digestText = await getDigestText(ctx.db);
  const haystacks = [CSV_CONTENT, QUESTION, JSON.stringify(turn.parts), digestText, getPromptConstantsText()];
  const numberCheck = checkNoInventedNumbers(turn.text, haystacks);
  notes.push(
    numberCheck.ok
      ? `no invented numbers (checked ${numberCheck.checked.length} tokens)`
      : `INVENTED numbers: ${numberCheck.invented.join(",")}`,
  );

  const pass = mentionsSmokeDetector && mentionsHydrantValve && mentionsFasCable && noAttachmentError && numberCheck.ok;
  return { pass, notes };
}

export const scenario: ConversationScenario = {
  slug: "file-analysis-turn",
  description:
    "A small fixture CSV attached to the turn (via the same storage + insertChatAttachment path the upload route uses) is embedded and read: the reply names its materials/quantities and invents no other figures.",
  run,
};
