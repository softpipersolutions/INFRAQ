/**
 * TEMPORARY Phase C UI-lane verification helper — NOT part of the shipped
 * app (mirrors wp6-smoke-seed.ts's pattern). Deleted after the manual
 * integration smoke test. Seeds a chat_sessions row with a fully confirmed
 * A.08 slot state for a given sessionId, so the chat UI's confirmation-card
 * -> chat.confirmEnquiry -> redirect flow can be exercised end to end without
 * a real model call.
 *
 * Usage: PGLITE_DIR=<dir> tsx scripts/chat-smoke-seed.ts <sessionId>
 * Must run while the web server is NOT holding the same PGLITE_DIR open
 * (PGlite's file backend is single-process).
 */
import { createDb, DEV_USER, ensureDevUser, getOrCreateChatSession, migrateDb, updateSlotState } from "@pebble/db";

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error("usage: chat-smoke-seed.ts <sessionId>");
  const pgliteDir = process.env.PGLITE_DIR;
  if (!pgliteDir) throw new Error("PGLITE_DIR env var required");

  const handle = await createDb({ pglite: true, pgliteDir });
  await migrateDb(handle);
  const db = handle.db as Parameters<typeof ensureDevUser>[0];
  await ensureDevUser(db);

  await getOrCreateChatSession(db, { sessionId, userId: DEV_USER.firebaseUid });

  const confirmed = (value: unknown) => ({ status: "confirmed", value });
  const slotState = {
    clientName: confirmed("Smoke Test Hospitality Pvt Ltd"),
    projectName: confirmed("Chat Smoke Test Hotel"),
    buildingType: confirmed("Commercial"),
    floorsAbove: confirmed(4),
    floorAreaSqm: confirmed(450),
    systemsRequired: confirmed(["FAS", "Extinguisher"]),
    makePreference: confirmed("As per Greenberg"),
    projectTier: confirmed(2),
    applicableStandard: confirmed("IS"),
    clientEmail: { status: "missing", value: null },
    clientPhone: { status: "missing", value: null },
    notes: { status: "missing", value: null },
  };

  await updateSlotState(db, sessionId, slotState);
  await handle.close();
  console.log(JSON.stringify({ ok: true, sessionId }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
