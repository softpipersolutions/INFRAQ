import { describe, expect, it } from "vitest";
import { guardExtractedFields } from "../src/extract";


describe("guardExtractedFields", () => {
  it("drops a hallucinated projectTier when the message doesn't signal a tier", () => {
    const g = guardExtractedFields({ floorsAbove: 6, projectTier: 1 }, "It's a 6-storey building.");
    expect(g.projectTier).toBeUndefined();
    expect(g.floorsAbove).toBe(6);
  });
  it("keeps projectTier when the message says 'tier'", () => {
    expect(guardExtractedFields({ projectTier: 3 }, "Put it down as a tier 3 project.").projectTier).toBe(3);
  });
  it("keeps projectTier when the message is a bare 1-4 answer", () => {
    expect(guardExtractedFields({ projectTier: 2 }, "2").projectTier).toBe(2);
    expect(guardExtractedFields({ projectTier: 4 }, "tier 4").projectTier).toBe(4);
  });
  it("leaves other fields untouched", () => {
    const g = guardExtractedFields({ systemsRequired: ["FAS"], floorAreaSqm: 450 }, "anything");
    expect(g).toEqual({ systemsRequired: ["FAS"], floorAreaSqm: 450 });
  });
});
