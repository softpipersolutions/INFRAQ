import { describe, expect, it } from "vitest";
import {
  proposeMaterialCode,
  sourceLocatorSchema,
  sourceProvenanceSchema,
  stagedInstallRateSchema,
  stagedMakeLinkSchema,
  stagedMaterialBundleSchema,
  stagedPayloadSchemaFor,
  stagedPricePointSchema,
} from "../src/ingestion";

/**
 * Frozen ingestion wire contracts: staged payloads round-trip and reject bad
 * shapes; the locator/provenance stamps enforce their invariants; proposed
 * material codes follow the PREFIX-ABBR-NNN house convention.
 */

describe("proposeMaterialCode", () => {
  it("starts a fresh sequence at 001 with the category abbreviation", () => {
    expect(proposeMaterialCode("FAS", "Detector", new Set())).toBe("FAS-DET-001");
  });

  it("continues past the highest existing sequence for that stem", () => {
    expect(proposeMaterialCode("FAS", "Detector", new Set(["FAS-DET-001"]))).toBe("FAS-DET-002");
    expect(
      proposeMaterialCode("FAS", "Detector", new Set(["FAS-DET-001", "FAS-DET-002", "FAS-DET-005"])),
    ).toBe("FAS-DET-006");
  });

  it("ignores unrelated existing codes", () => {
    expect(
      proposeMaterialCode("FAS", "Detector", new Set(["HYD-PUMP-001", "FAS-PNL-003"])),
    ).toBe("FAS-DET-001");
  });

  it("maps each system to its house prefix", () => {
    const s = new Set<string>();
    expect(proposeMaterialCode("FAS", "Panel", s)).toBe("FAS-PNL-001");
    expect(proposeMaterialCode("Hydrant", "Pump", s)).toBe("HYD-PUMP-001");
    expect(proposeMaterialCode("Sprinkler", "Fitting", s)).toBe("SPR-FIT-001");
    expect(proposeMaterialCode("Extinguisher", "Extinguisher", s)).toBe("EXT-EXTG-001");
    expect(proposeMaterialCode("Suppression", "Accessory", s)).toBe("SUP-ACC-001");
    expect(proposeMaterialCode("Common", "Signage", s)).toBe("COM-SIGN-001");
  });

  it("derives an abbreviation for an unseen category (first token, ≤4 chars)", () => {
    expect(proposeMaterialCode("Common", "Widget Gizmo", new Set())).toBe("COM-WIDG-001");
  });
});

// ── Valid fixtures ──────────────────────────────────────────────────────────
const validBundle = {
  payloadVersion: 1 as const,
  material: {
    materialCode: "FAS-DET-007",
    materialName: "Beam Smoke Detector",
    systemType: "FAS" as const,
    category: "Detector",
    unitOfMeasure: { raw: "Nos", normalized: "No." as const },
    specSummary: "reflective beam, 100 m",
  },
  make: { brandName: { raw: "Agni", normalized: "Agni Devices" }, tier: "Standard" as const },
  price: {
    sellRupees: 12500,
    buyRupees: 9800,
    rateKind: "SUPPLY" as const,
    validFromISO: "2024-03-01T00:00:00.000Z",
  },
  installRate: { rupees: 450, unit: "Per No." },
  sourceText: "Beam detector, Agni make, Rs 12500",
};

const validPrice = {
  payloadVersion: 1 as const,
  materialCode: "FAS-SMK-001",
  brandName: { raw: "Honeywell (UL)", normalized: "Honeywell" },
  sellRupees: 2650,
  buyRupees: 2050,
  rateKind: "SITC" as const,
  validFromISO: null,
  sourceText: "Honeywell smoke detector Rs 2650",
};

const validMakeLink = {
  payloadVersion: 1 as const,
  materialCode: "HYD-PIPE-100",
  brandName: { raw: "Jindal", normalized: "Jindal" },
  tier: null,
  sourceText: "Pipe make: Jindal",
};

const validInstall = {
  payloadVersion: 1 as const,
  materialCode: null,
  systemType: "Sprinkler" as const,
  unit: "Per Metre",
  rupees: 120,
  sourceText: "Sprinkler piping installation Rs 120/m",
};

describe("staged payload round-trips", () => {
  it("parses a valid material bundle", () => {
    expect(stagedMaterialBundleSchema.parse(validBundle)).toEqual(validBundle);
  });

  it("parses a valid material bundle with only required fields", () => {
    const minimal = {
      payloadVersion: 1 as const,
      material: {
        materialCode: "COM-SIGN-002",
        materialName: "Exit sign",
        systemType: "Common" as const,
        category: "Signage",
        unitOfMeasure: { raw: "???", normalized: null },
      },
      make: { brandName: { raw: "Unknown Co", normalized: null } },
      price: { sellRupees: null, rateKind: "UNKNOWN" as const, validFromISO: null },
      sourceText: "row with no price",
    };
    expect(() => stagedMaterialBundleSchema.parse(minimal)).not.toThrow();
  });

  it("parses valid price / make / install payloads", () => {
    expect(stagedPricePointSchema.parse(validPrice)).toEqual(validPrice);
    expect(stagedMakeLinkSchema.parse(validMakeLink)).toEqual(validMakeLink);
    expect(stagedInstallRateSchema.parse(validInstall)).toEqual(validInstall);
  });
});

describe("stagedPayloadSchemaFor", () => {
  it("maps each target master to its schema", () => {
    expect(stagedPayloadSchemaFor("materials")).toBe(stagedMaterialBundleSchema);
    expect(stagedPayloadSchemaFor("makes")).toBe(stagedMakeLinkSchema);
    expect(stagedPayloadSchemaFor("prices")).toBe(stagedPricePointSchema);
    expect(stagedPayloadSchemaFor("install_rates")).toBe(stagedInstallRateSchema);
  });

  it("validates a real payload through the resolved schema", () => {
    expect(() => stagedPayloadSchemaFor("prices").parse(validPrice)).not.toThrow();
  });
});

describe("staged payload rejection", () => {
  it("rejects a non-v1 payloadVersion", () => {
    expect(stagedPricePointSchema.safeParse({ ...validPrice, payloadVersion: 2 }).success).toBe(
      false,
    );
  });

  it("rejects a negative price", () => {
    expect(stagedPricePointSchema.safeParse({ ...validPrice, sellRupees: -5 }).success).toBe(false);
  });

  it("rejects an unknown rateKind", () => {
    expect(stagedPricePointSchema.safeParse({ ...validPrice, rateKind: "FLOAT" }).success).toBe(
      false,
    );
  });

  it("rejects a missing sourceText", () => {
    const { sourceText, ...rest } = validMakeLink;
    void sourceText;
    expect(stagedMakeLinkSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an out-of-enum systemType in a bundle", () => {
    const bad = { ...validBundle, material: { ...validBundle.material, systemType: "Plumbing" } };
    expect(stagedMaterialBundleSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-canonical unitOfMeasure.normalized", () => {
    const bad = {
      ...validBundle,
      material: { ...validBundle.material, unitOfMeasure: { raw: "nos", normalized: "Nos" } },
    };
    expect(stagedMaterialBundleSchema.safeParse(bad).success).toBe(false);
  });
});

describe("sourceLocatorSchema", () => {
  it("accepts any single locating field", () => {
    expect(sourceLocatorSchema.safeParse({ page: 3 }).success).toBe(true);
    expect(sourceLocatorSchema.safeParse({ sheet: "BOQ", row: 12 }).success).toBe(true);
    expect(sourceLocatorSchema.safeParse({ slNo: "1.2.a" }).success).toBe(true);
    expect(sourceLocatorSchema.safeParse({ pageStart: 4, pageEnd: 9 }).success).toBe(true);
  });

  it("rejects an empty locator", () => {
    expect(sourceLocatorSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-positive page", () => {
    expect(sourceLocatorSchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("sourceProvenanceSchema", () => {
  const validProvenance = {
    sourceDocumentId: "01J-doc",
    extractionRunId: "01J-run",
    stagedRecordId: "01J-staged",
    filename: "GBE-2024-Mall.pdf",
    page: 7,
    promptVersion: "ingest-2024-11",
    committedBy: "reviewer@greenberg",
    committedAt: "2026-07-18T10:30:00.000Z",
  };

  it("parses a full provenance stamp", () => {
    expect(() => sourceProvenanceSchema.parse(validProvenance)).not.toThrow();
  });

  it("rejects a non-ISO committedAt", () => {
    expect(
      sourceProvenanceSchema.safeParse({ ...validProvenance, committedAt: "18-07-2026" }).success,
    ).toBe(false);
  });

  it("rejects a missing required id", () => {
    const { stagedRecordId, ...rest } = validProvenance;
    void stagedRecordId;
    expect(sourceProvenanceSchema.safeParse(rest).success).toBe(false);
  });
});
