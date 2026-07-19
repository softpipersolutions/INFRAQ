import { describe, expect, it } from "vitest";
import {
  applyExtracted,
  buildSessionStateBlock,
  confirmAllProposed,
  initSlotState,
  type ExtractedFields,
} from "../src/index";

const COMPLETE: ExtractedFields = {
  clientName: "Acme Retail",
  projectName: "Hazratganj Mall",
  buildingType: "Commercial",
  floorsAbove: 4,
  floorAreaSqm: 450,
  systemsRequired: ["FAS", "Sprinkler"],
  makePreference: "As per Greenberg",
  projectTier: 2,
};

describe("buildSessionStateBlock", () => {
  it("empty capture: 0/8, everything still needed, not ready, no enquiry", () => {
    const block = buildSessionStateBlock({
      slotState: initSlotState(),
      enquiryId: null,
      contradictions: 0,
    });
    expect(block).toContain("Captured: 0/8 required fields confirmed.");
    expect(block).toContain("Still needed (required): clientName, projectName, buildingType");
    expect(block).toContain("Ready to confirm: no");
    expect(block).toMatch(/Validation: not ready/);
    expect(block).toContain("Linked: no enquiry created yet.");
    expect(block).toContain("Contradictions logged this session: 0");
    expect(block).toMatch(/Suggested next step \(advisory\): capture is incomplete/);
  });

  it("mid capture: reflects confirmed, proposed and still-needed splits", () => {
    let s = initSlotState();
    s = applyExtracted(s, { clientName: "Acme Retail", projectName: "Hazratganj Mall" });
    s = confirmAllProposed(s);
    s = applyExtracted(s, { buildingType: "Commercial" });

    const block = buildSessionStateBlock({ slotState: s, enquiryId: null, contradictions: 1 });
    expect(block).toContain("Captured: 2/8 required fields confirmed.");
    expect(block).toContain("Confirmed: clientName=Acme Retail, projectName=Hazratganj Mall");
    expect(block).toContain("Proposed (awaiting user yes): buildingType=Commercial");
    expect(block).toContain("Still needed (required): floorsAbove, floorAreaSqm, systemsRequired, makePreference, projectTier");
    expect(block).toContain("Contradictions logged this session: 1");
  });

  it("complete + confirmed: 8/8, validates cleanly, ready, restate-and-yes suggestion", () => {
    let s = initSlotState();
    s = applyExtracted(s, COMPLETE);
    s = confirmAllProposed(s);

    const block = buildSessionStateBlock({ slotState: s, enquiryId: null, contradictions: 0 });
    expect(block).toContain("Captured: 8/8 required fields confirmed.");
    expect(block).toContain("Validation: validates cleanly");
    expect(block).toContain("Ready to confirm: yes");
    expect(block).toMatch(/restate it and, on an explicit yes, call create_enquiry/);
  });

  it("linked: shows the enquiry/estimate and warns against creating again", () => {
    let s = initSlotState();
    s = applyExtracted(s, COMPLETE);
    s = confirmAllProposed(s);

    const block = buildSessionStateBlock({
      slotState: s,
      enquiryId: "GBE-ENQ-2026-001",
      estimateSummary: { estimateId: "GBE-EST-2026-001", sitcStatus: "in-band", versionNo: 1 },
      contradictions: 0,
    });
    expect(block).toContain("Linked: enquiry GBE-ENQ-2026-001, estimate GBE-EST-2026-001 v1 (SITC in-band).");
    expect(block).toMatch(/an enquiry already exists for this session — do not create another/);
  });

  it("surfaces validation issues from buildEnquiryInput", () => {
    let s = initSlotState();
    s = applyExtracted(s, {
      ...COMPLETE,
      buildingType: "Spaceship" as unknown as ExtractedFields["buildingType"],
    });
    s = confirmAllProposed(s);

    const block = buildSessionStateBlock({ slotState: s, enquiryId: null, contradictions: 0 });
    expect(block).toMatch(/Validation: not ready/);
    expect(block).toMatch(/buildingType/);
    expect(block).toContain("Ready to confirm: no");
  });
});
