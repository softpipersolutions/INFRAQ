import { describe, expect, it } from "vitest";
import {
  allRequiredConfirmed,
  applyExtracted,
  buildEnquiryInput,
  confirmAllProposed,
  confirmSlot,
  detectConfirmedOverwrite,
  initSlotState,
  nextAction,
  type ExtractedFields,
} from "../src/index";

describe("slot-filling state machine", () => {
  it("starts with every required field missing and asks for the first one", () => {
    const s = initSlotState();
    const action = nextAction(s);
    expect(action.kind).toBe("ask");
    if (action.kind === "ask") expect(action.field).toBe("clientName");
  });

  it("extraction proposes values and advances the next question", () => {
    let s = initSlotState();
    s = applyExtracted(s, { clientName: "Acme Retail", projectName: "Contoso Ganj Mall" });
    expect(s.clientName.status).toBe("proposed");
    const action = nextAction(s);
    // clientName and projectName proposed → next missing required is buildingType
    expect(action.kind).toBe("ask");
    if (action.kind === "ask") expect(action.field).toBe("buildingType");
  });

  it("moves to a confirmation step once all required fields are at least proposed", () => {
    let s = initSlotState();
    s = applyExtracted(s, {
      clientName: "Acme Retail",
      projectName: "Contoso Ganj Mall",
      buildingType: "Commercial",
      floorsAbove: 4,
      floorAreaSqm: 450,
      systemsRequired: ["FAS", "Extinguisher"],
      makePreference: "As per Greenberg",
      projectTier: 2,
    });
    const action = nextAction(s);
    expect(action.kind).toBe("confirm");
  });

  it("builds a valid EnquiryInput once confirmed, reusing the form's zod schema", () => {
    let s = initSlotState();
    s = applyExtracted(s, {
      clientName: "Acme Retail",
      projectName: "Contoso Ganj Mall",
      buildingType: "Commercial",
      floorsAbove: 4,
      floorAreaSqm: 450,
      systemsRequired: ["FAS", "Extinguisher"],
      makePreference: "As per Greenberg",
      projectTier: 2,
    });
    s = confirmAllProposed(s);
    expect(allRequiredConfirmed(s)).toBe(true);
    expect(nextAction(s).kind).toBe("complete");

    const built = buildEnquiryInput(s);
    expect(built.ok, JSON.stringify(built.issues)).toBe(true);
    expect(built.input?.clientName).toBe("Acme Retail");
    expect(built.input?.source).toBe("chat");
    expect(built.input?.applicableStandard).toBe("IS"); // default filled
  });

  it("rejects an invalid assembly (e.g. bad building type) with issues", () => {
    // The extraction schema now enum-constrains buildingType, so a bad value
    // can only arrive through a stale/corrupt persisted slot state — simulate
    // that by casting past the compile-time enum (the runtime validation in
    // buildEnquiryInput is exactly what this test pins down).
    let s = initSlotState();
    s = applyExtracted(s, {
      clientName: "X",
      projectName: "Y",
      buildingType: "Spaceship" as unknown as ExtractedFields["buildingType"],
      floorsAbove: 4,
      floorAreaSqm: 450,
      systemsRequired: ["FAS"],
      makePreference: "As per Greenberg",
      projectTier: 2,
    });
    s = confirmAllProposed(s);
    const built = buildEnquiryInput(s);
    expect(built.ok).toBe(false);
    expect(built.issues?.some((i) => i.startsWith("buildingType"))).toBe(true);
  });

  it("confirmSlot only confirms a slot that has a value", () => {
    let s = initSlotState();
    s = confirmSlot(s, "clientName"); // still null → stays missing
    expect(s.clientName.status).toBe("missing");
    s = applyExtracted(s, { clientName: "Acme" });
    s = confirmSlot(s, "clientName");
    expect(s.clientName.status).toBe("confirmed");
  });
});

describe("detectConfirmedOverwrite", () => {
  function confirmed(fields: ExtractedFields) {
    return confirmAllProposed(applyExtracted(initSlotState(), fields));
  }

  it("flags a confirmed slot whose value would change", () => {
    const s = confirmed({ clientName: "Acme", floorsAbove: 4 });
    expect(detectConfirmedOverwrite(s, { floorsAbove: 6 })).toEqual(["floorsAbove"]);
  });

  it("does not flag re-confirming the same value", () => {
    const s = confirmed({ floorsAbove: 4 });
    expect(detectConfirmedOverwrite(s, { floorsAbove: 4 })).toEqual([]);
  });

  it("ignores proposed/missing slots — only confirmed values count", () => {
    let s = applyExtracted(initSlotState(), { clientName: "Acme" }); // proposed, not confirmed
    s = applyExtracted(s, { floorsAbove: 4 });
    // clientName is proposed (not confirmed) → changing it is not an overwrite
    expect(detectConfirmedOverwrite(s, { clientName: "Beta", buildingType: "Commercial" })).toEqual([]);
  });

  it("compares arrays element-wise and reports multiple changed fields", () => {
    const s = confirmed({ systemsRequired: ["FAS"], projectTier: 2, clientName: "Acme" });
    const changed = detectConfirmedOverwrite(s, {
      systemsRequired: ["FAS", "Sprinkler"],
      projectTier: 3,
      clientName: "Acme", // unchanged → not reported
    });
    expect(changed.sort()).toEqual(["projectTier", "systemsRequired"]);
  });

  it("ignores omitted fields", () => {
    const s = confirmed({ clientName: "Acme", floorsAbove: 4 });
    expect(detectConfirmedOverwrite(s, {})).toEqual([]);
  });
});
