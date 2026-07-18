import type {
  ApplicableStandard,
  ApprovalStatus,
  InstallRateUnit,
  MakeTier,
  MarginRow,
  MaterialCategory,
  SystemType,
  UnitOfMeasure,
} from "@pebble/shared";

/**
 * Seed dataset — starter masters drawn from the historical corpus analysis
 * (`Amitabh Fire Safety BOQ Data/`) and Greenberg's IS-code design basis.
 *
 * Invariants that make the demo generation clean (see PROGRESS.md §5):
 *  - Every material has an Approved **Standard** make (the tier chosen for
 *    make_preference "As per Greenberg") with a price, plus a material-linked
 *    install rate — so generation raises zero warnings.
 *  - Each install rate = 43% of that material's Standard selling rate, so every
 *    priced line's SITC ratio is Supply×1.43 and the blended ratio lands dead
 *    centre of the [1.35, 1.51] acceptance band → SITC PASS.
 *  - Standard buying rates sit ~20–28% below selling → blended margin clears the
 *    tier floors comfortably → margin status OK.
 *
 * Rupee figures below are whole rupees; the seeder converts to integer paise.
 */

export interface SeedMake {
  makeCode: string;
  brand: string;
  tier: MakeTier;
  approval: ApprovalStatus;
  sell: number; // ₹ selling (SITC-basis supply) rate
  buy: number; // ₹ buying rate
}

export interface SeedMaterial {
  code: string;
  name: string;
  system: SystemType;
  category: MaterialCategory;
  unit: UnitOfMeasure;
  standard: ApplicableStandard;
  rating: string | null;
  size: string | null;
  certifications: string[];
  /** Per-unit install unit compatible with `unit` (Per No./Per Metre/Per Set). */
  installUnit: InstallRateUnit;
  makes: SeedMake[];
}

export interface SeedRule {
  ruleCode: string;
  system: SystemType;
  condition: string;
  quantity: string;
  outputMaterialCode: string;
  standardReference: string;
}

const M = (m: SeedMaterial): SeedMaterial => m;

export const SEED_MATERIALS: SeedMaterial[] = [
  // ─── Fire Alarm System (FAS) ──────────────────────────────────────────────
  M({
    code: "FAS-SMK-001",
    name: "Photoelectric Smoke Detector",
    system: "FAS",
    category: "Detector",
    unit: "No.",
    standard: "IS",
    rating: "Photoelectric, 2-wire",
    size: null,
    certifications: ["IS 2189", "EN 54-7"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-SMK-001-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 1450, buy: 1050 },
      { makeCode: "FAS-SMK-001-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 2650, buy: 2050 },
      { makeCode: "FAS-SMK-001-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 1150, buy: 900 },
    ],
  }),
  M({
    code: "FAS-HEAT-001",
    name: "Rate-of-Rise Heat Detector",
    system: "FAS",
    category: "Detector",
    unit: "No.",
    standard: "IS",
    rating: "RoR + fixed 57°C",
    size: null,
    certifications: ["IS 2189"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-HEAT-001-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 1350, buy: 980 },
      { makeCode: "FAS-HEAT-001-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 2400, buy: 1850 },
      { makeCode: "FAS-HEAT-001-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 1050, buy: 820 },
    ],
  }),
  M({
    code: "FAS-MCP-001",
    name: "Manual Call Point (break-glass)",
    system: "FAS",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: null,
    certifications: ["IS 2189"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-MCP-001-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 950, buy: 700 },
      { makeCode: "FAS-MCP-001-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 1850, buy: 1400 },
      { makeCode: "FAS-MCP-001-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 780, buy: 600 },
    ],
  }),
  M({
    code: "FAS-HOOT-001",
    name: "Hooter cum Strobe",
    system: "FAS",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: "24V DC",
    size: null,
    certifications: ["IS 2189"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-HOOT-001-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 1250, buy: 950 },
      { makeCode: "FAS-HOOT-001-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 2100, buy: 1650 },
      { makeCode: "FAS-HOOT-001-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 980, buy: 760 },
    ],
  }),
  M({
    code: "FAS-RI-001",
    name: "Response Indicator",
    system: "FAS",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: null,
    certifications: ["IS 2189"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-RI-001-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 320, buy: 240 },
      { makeCode: "FAS-RI-001-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 480, buy: 370 },
      { makeCode: "FAS-RI-001-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 260, buy: 200 },
    ],
  }),
  M({
    code: "FAS-PANEL-002",
    name: "Addressable Fire Alarm Panel (2-loop)",
    system: "FAS",
    category: "Panel",
    unit: "No.",
    standard: "IS",
    rating: "2 loop, 240V",
    size: null,
    certifications: ["IS 2189", "EN 54-2"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-PANEL-002-AGNI", brand: "Agni Devices", tier: "Standard", approval: "Approved", sell: 85000, buy: 66000 },
      { makeCode: "FAS-PANEL-002-HON", brand: "Honeywell", tier: "Premium", approval: "Approved", sell: 145000, buy: 115000 },
      { makeCode: "FAS-PANEL-002-RAV", brand: "Ravel", tier: "Economy", approval: "Approved", sell: 62000, buy: 49000 },
    ],
  }),
  M({
    code: "FAS-CABLE-001",
    name: "FRLS Armoured Cable 2C x 1.5 sqmm",
    system: "FAS",
    category: "Cable",
    unit: "Metre",
    standard: "IS",
    rating: "FRLS",
    size: "2C x 1.5 sqmm",
    certifications: ["IS 1554"],
    installUnit: "Per Metre",
    makes: [
      { makeCode: "FAS-CABLE-001-POLY", brand: "Polycab", tier: "Standard", approval: "Approved", sell: 85, buy: 62 },
      { makeCode: "FAS-CABLE-001-FIN", brand: "Finolex", tier: "Premium", approval: "Approved", sell: 110, buy: 85 },
      { makeCode: "FAS-CABLE-001-RR", brand: "RR Kabel", tier: "Economy", approval: "Approved", sell: 68, buy: 52 },
    ],
  }),
  M({
    code: "FAS-BATT-001",
    name: "SMF Standby Battery 12V 7Ah",
    system: "FAS",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: "12V 7Ah",
    size: null,
    certifications: ["IS 1651"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "FAS-BATT-001-EXIDE", brand: "Exide", tier: "Standard", approval: "Approved", sell: 1850, buy: 1450 },
      { makeCode: "FAS-BATT-001-AMA", brand: "Amaron", tier: "Premium", approval: "Approved", sell: 2200, buy: 1750 },
      { makeCode: "FAS-BATT-001-LOC", brand: "Generic", tier: "Economy", approval: "Conditional", sell: 1400, buy: 1100 },
    ],
  }),

  // ─── Portable Extinguishers ───────────────────────────────────────────────
  M({
    code: "EXT-ABC-001",
    name: "ABC Dry Powder Extinguisher 4kg",
    system: "Extinguisher",
    category: "Extinguisher",
    unit: "No.",
    standard: "IS",
    rating: "4 kg, MAP 90%",
    size: "4 kg",
    certifications: ["IS 15683"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "EXT-ABC-001-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 2100, buy: 1600 },
      { makeCode: "EXT-ABC-001-CEASE", brand: "Ceasefire", tier: "Premium", approval: "Approved", sell: 3200, buy: 2500 },
      { makeCode: "EXT-ABC-001-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 1750, buy: 1350 },
    ],
  }),
  M({
    code: "EXT-ABC-002",
    name: "ABC Dry Powder Extinguisher 6kg",
    system: "Extinguisher",
    category: "Extinguisher",
    unit: "No.",
    standard: "IS",
    rating: "6 kg, MAP 90%",
    size: "6 kg",
    certifications: ["IS 15683"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "EXT-ABC-002-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 2650, buy: 2050 },
      { makeCode: "EXT-ABC-002-CEASE", brand: "Ceasefire", tier: "Premium", approval: "Approved", sell: 3900, buy: 3050 },
      { makeCode: "EXT-ABC-002-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 2200, buy: 1700 },
    ],
  }),
  M({
    code: "EXT-CO2-001",
    name: "CO2 Extinguisher 4.5kg",
    system: "Extinguisher",
    category: "Extinguisher",
    unit: "No.",
    standard: "IS",
    rating: "4.5 kg",
    size: "4.5 kg",
    certifications: ["IS 15683"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "EXT-CO2-001-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 5200, buy: 4050 },
      { makeCode: "EXT-CO2-001-CEASE", brand: "Ceasefire", tier: "Premium", approval: "Approved", sell: 7200, buy: 5700 },
      { makeCode: "EXT-CO2-001-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 4400, buy: 3450 },
    ],
  }),
  M({
    code: "EXT-WCO2-001",
    name: "Water-CO2 Extinguisher 9L",
    system: "Extinguisher",
    category: "Extinguisher",
    unit: "No.",
    standard: "IS",
    rating: "9 L stored pressure",
    size: "9 L",
    certifications: ["IS 15683"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "EXT-WCO2-001-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 3200, buy: 2500 },
      { makeCode: "EXT-WCO2-001-CEASE", brand: "Ceasefire", tier: "Premium", approval: "Approved", sell: 4600, buy: 3650 },
      { makeCode: "EXT-WCO2-001-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 2700, buy: 2100 },
    ],
  }),
  M({
    code: "EXT-STAND-001",
    name: "MS Extinguisher Stand (2-unit)",
    system: "Extinguisher",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: null,
    certifications: [],
    installUnit: "Per No.",
    makes: [
      { makeCode: "EXT-STAND-001-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 650, buy: 480 },
      { makeCode: "EXT-STAND-001-CEASE", brand: "Ceasefire", tier: "Premium", approval: "Approved", sell: 880, buy: 690 },
      { makeCode: "EXT-STAND-001-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 520, buy: 400 },
    ],
  }),

  // ─── Wet Riser / Hydrant ──────────────────────────────────────────────────
  M({
    code: "HYD-PIPE-100",
    name: "MS Hydrant Pipe 100mm (C-Class)",
    system: "Hydrant",
    category: "Pipe",
    unit: "Metre",
    standard: "IS",
    rating: "C-Class",
    size: "100 mm",
    certifications: ["IS 1239", "IS 3589"],
    installUnit: "Per Metre",
    makes: [
      { makeCode: "HYD-PIPE-100-JIN", brand: "Jindal", tier: "Standard", approval: "Approved", sell: 1450, buy: 1120 },
      { makeCode: "HYD-PIPE-100-TATA", brand: "Tata", tier: "Premium", approval: "Approved", sell: 1750, buy: 1380 },
      { makeCode: "HYD-PIPE-100-APL", brand: "APL Apollo", tier: "Economy", approval: "Approved", sell: 1250, buy: 980 },
    ],
  }),
  M({
    code: "HYD-PIPE-150",
    name: "MS Hydrant Pipe 150mm",
    system: "Hydrant",
    category: "Pipe",
    unit: "Metre",
    standard: "IS",
    rating: "C-Class",
    size: "150 mm",
    certifications: ["IS 3589"],
    installUnit: "Per Metre",
    makes: [
      { makeCode: "HYD-PIPE-150-JIN", brand: "Jindal", tier: "Standard", approval: "Approved", sell: 2250, buy: 1780 },
      { makeCode: "HYD-PIPE-150-TATA", brand: "Tata", tier: "Premium", approval: "Approved", sell: 2700, buy: 2150 },
      { makeCode: "HYD-PIPE-150-APL", brand: "APL Apollo", tier: "Economy", approval: "Approved", sell: 1950, buy: 1550 },
    ],
  }),
  M({
    code: "HYD-LH-001",
    name: "Landing Valve 63mm (Gunmetal)",
    system: "Hydrant",
    category: "Valve",
    unit: "No.",
    standard: "IS",
    rating: "63 mm, single outlet",
    size: "63 mm",
    certifications: ["IS 5290"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-LH-001-ZOL", brand: "Zoloto", tier: "Standard", approval: "Approved", sell: 3200, buy: 2500 },
      { makeCode: "HYD-LH-001-KAR", brand: "Kartar", tier: "Premium", approval: "Approved", sell: 3800, buy: 3000 },
      { makeCode: "HYD-LH-001-NEW", brand: "Newage", tier: "Economy", approval: "Approved", sell: 2700, buy: 2150 },
    ],
  }),
  M({
    code: "HYD-HOSE-001",
    name: "RRL Fire Hose 63mm x 15m",
    system: "Hydrant",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: "Type-A RRL",
    size: "63 mm x 15 m",
    certifications: ["IS 636"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-HOSE-001-NEW", brand: "Newage", tier: "Standard", approval: "Approved", sell: 3400, buy: 2650 },
      { makeCode: "HYD-HOSE-001-ZEN", brand: "Zenith", tier: "Premium", approval: "Approved", sell: 4200, buy: 3350 },
      { makeCode: "HYD-HOSE-001-LOC", brand: "Generic", tier: "Economy", approval: "Conditional", sell: 2900, buy: 2300 },
    ],
  }),
  M({
    code: "HYD-NOZ-001",
    name: "Branch Pipe & Nozzle 63mm",
    system: "Hydrant",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: "63 mm",
    certifications: ["IS 903"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-NOZ-001-ZOL", brand: "Zoloto", tier: "Standard", approval: "Approved", sell: 1450, buy: 1120 },
      { makeCode: "HYD-NOZ-001-KAR", brand: "Kartar", tier: "Premium", approval: "Approved", sell: 1850, buy: 1450 },
      { makeCode: "HYD-NOZ-001-NEW", brand: "Newage", tier: "Economy", approval: "Approved", sell: 1200, buy: 950 },
    ],
  }),
  M({
    code: "HYD-HB-001",
    name: "Hose Box (MS, double-door)",
    system: "Hydrant",
    category: "Accessory",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: null,
    certifications: [],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-HB-001-ZEN", brand: "Zenith", tier: "Standard", approval: "Approved", sell: 4200, buy: 3300 },
      { makeCode: "HYD-HB-001-PRE", brand: "Premium Fab", tier: "Premium", approval: "Approved", sell: 5500, buy: 4400 },
      { makeCode: "HYD-HB-001-LOC", brand: "Generic", tier: "Economy", approval: "Approved", sell: 3600, buy: 2850 },
    ],
  }),
  M({
    code: "HYD-PUMP-MAIN",
    name: "Main Hydrant Pump 2280 LPM (electric)",
    system: "Hydrant",
    category: "Pump",
    unit: "No.",
    standard: "NBC 2016",
    rating: "2280 LPM @ 88m",
    size: null,
    certifications: ["IS 12469", "UL Listed"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-PUMP-MAIN-KIR", brand: "Kirloskar", tier: "Standard", approval: "Approved", sell: 285000, buy: 230000 },
      { makeCode: "HYD-PUMP-MAIN-GRU", brand: "Grundfos", tier: "Premium", approval: "Approved", sell: 385000, buy: 312000 },
      { makeCode: "HYD-PUMP-MAIN-LUBI", brand: "Lubi", tier: "Economy", approval: "Approved", sell: 245000, buy: 198000 },
    ],
  }),
  M({
    code: "HYD-PUMP-JOCKEY",
    name: "Jockey Pump 180 LPM",
    system: "Hydrant",
    category: "Pump",
    unit: "No.",
    standard: "NBC 2016",
    rating: "180 LPM @ 88m",
    size: null,
    certifications: ["IS 12469"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-PUMP-JOCKEY-KIR", brand: "Kirloskar", tier: "Standard", approval: "Approved", sell: 65000, buy: 51000 },
      { makeCode: "HYD-PUMP-JOCKEY-GRU", brand: "Grundfos", tier: "Premium", approval: "Approved", sell: 92000, buy: 74000 },
      { makeCode: "HYD-PUMP-JOCKEY-LUBI", brand: "Lubi", tier: "Economy", approval: "Approved", sell: 54000, buy: 43000 },
    ],
  }),
  M({
    code: "HYD-PUMP-DIESEL",
    name: "Diesel Engine Fire Pump 2280 LPM",
    system: "Hydrant",
    category: "Pump",
    unit: "No.",
    standard: "NBC 2016",
    rating: "2280 LPM standby",
    size: null,
    certifications: ["IS 1520"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "HYD-PUMP-DIESEL-KIR", brand: "Kirloskar", tier: "Standard", approval: "Approved", sell: 425000, buy: 345000 },
      { makeCode: "HYD-PUMP-DIESEL-CUM", brand: "Cummins", tier: "Premium", approval: "Approved", sell: 560000, buy: 455000 },
      { makeCode: "HYD-PUMP-DIESEL-LUBI", brand: "Lubi", tier: "Economy", approval: "Approved", sell: 365000, buy: 298000 },
    ],
  }),

  // ─── Sprinkler ────────────────────────────────────────────────────────────
  M({
    code: "SPR-HEAD-001",
    name: "Pendant Sprinkler 68°C 15mm",
    system: "Sprinkler",
    category: "Fitting",
    unit: "No.",
    standard: "UL Listed",
    rating: "68°C, K80",
    size: "15 mm",
    certifications: ["IS 15105", "UL Listed"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "SPR-HEAD-001-TYCO", brand: "Tyco", tier: "Standard", approval: "Approved", sell: 185, buy: 140 },
      { makeCode: "SPR-HEAD-001-VIK", brand: "Viking", tier: "Premium", approval: "Approved", sell: 260, buy: 205 },
      { makeCode: "SPR-HEAD-001-OMA", brand: "Omaxe", tier: "Economy", approval: "Approved", sell: 150, buy: 118 },
    ],
  }),
  M({
    code: "SPR-PIPE-050",
    name: "MS Sprinkler Pipe 50mm",
    system: "Sprinkler",
    category: "Pipe",
    unit: "Metre",
    standard: "IS",
    rating: "C-Class",
    size: "50 mm",
    certifications: ["IS 1239"],
    installUnit: "Per Metre",
    makes: [
      { makeCode: "SPR-PIPE-050-JIN", brand: "Jindal", tier: "Standard", approval: "Approved", sell: 680, buy: 525 },
      { makeCode: "SPR-PIPE-050-TATA", brand: "Tata", tier: "Premium", approval: "Approved", sell: 820, buy: 650 },
      { makeCode: "SPR-PIPE-050-APL", brand: "APL Apollo", tier: "Economy", approval: "Approved", sell: 580, buy: 455 },
    ],
  }),
  M({
    code: "SPR-VALVE-001",
    name: "Alarm Check Valve 150mm",
    system: "Sprinkler",
    category: "Valve",
    unit: "No.",
    standard: "UL Listed",
    rating: "150 mm wet",
    size: "150 mm",
    certifications: ["UL Listed"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "SPR-VALVE-001-TYCO", brand: "Tyco", tier: "Standard", approval: "Approved", sell: 42000, buy: 33000 },
      { makeCode: "SPR-VALVE-001-VIK", brand: "Viking", tier: "Premium", approval: "Approved", sell: 58000, buy: 46500 },
      { makeCode: "SPR-VALVE-001-ZOL", brand: "Zoloto", tier: "Economy", approval: "Approved", sell: 36000, buy: 28500 },
    ],
  }),
  M({
    code: "SPR-FDV-001",
    name: "Water Flow Switch",
    system: "Sprinkler",
    category: "Accessory",
    unit: "No.",
    standard: "UL Listed",
    rating: null,
    size: null,
    certifications: ["UL Listed"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "SPR-FDV-001-SS", brand: "System Sensor", tier: "Standard", approval: "Approved", sell: 3200, buy: 2500 },
      { makeCode: "SPR-FDV-001-POT", brand: "Potter", tier: "Premium", approval: "Approved", sell: 4200, buy: 3350 },
      { makeCode: "SPR-FDV-001-GEN", brand: "Generic", tier: "Economy", approval: "Conditional", sell: 2700, buy: 2150 },
    ],
  }),

  // ─── Suppression / Common ─────────────────────────────────────────────────
  M({
    code: "SUP-CLEAN-001",
    name: "Clean Agent (FK-5-1-12) Cylinder 40L",
    system: "Suppression",
    category: "Accessory",
    unit: "No.",
    standard: "UL Listed",
    rating: "40 L, FK-5-1-12",
    size: "40 L",
    certifications: ["IS 15493", "UL Listed"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "SUP-CLEAN-001-CEASE", brand: "Ceasefire", tier: "Standard", approval: "Approved", sell: 165000, buy: 132000 },
      { makeCode: "SUP-CLEAN-001-KID", brand: "Kidde", tier: "Premium", approval: "Approved", sell: 235000, buy: 190000 },
      { makeCode: "SUP-CLEAN-001-ELI", brand: "Elitech", tier: "Economy", approval: "Approved", sell: 142000, buy: 114000 },
    ],
  }),
  M({
    code: "COM-SIGN-001",
    name: "Photoluminescent Exit Signage",
    system: "Common",
    category: "Signage",
    unit: "No.",
    standard: "IS",
    rating: null,
    size: "300 x 150 mm",
    certifications: ["IS 15683"],
    installUnit: "Per No.",
    makes: [
      { makeCode: "COM-SIGN-001-SAFE", brand: "Safepro", tier: "Standard", approval: "Approved", sell: 480, buy: 360 },
      { makeCode: "COM-SIGN-001-JAL", brand: "Jalite", tier: "Premium", approval: "Approved", sell: 720, buy: 570 },
      { makeCode: "COM-SIGN-001-LOC", brand: "Generic", tier: "Economy", approval: "Approved", sell: 380, buy: 300 },
    ],
  }),
];

export const SEED_RULES: SeedRule[] = [
  // FAS
  { ruleCode: "DL-FAS-001", system: "FAS", condition: "system = FAS", quantity: "CEIL(total_area_sqm / 60)", outputMaterialCode: "FAS-SMK-001", standardReference: "IS 2189 cl.6 — 1 smoke detector per 60 sqm" },
  { ruleCode: "DL-FAS-002", system: "FAS", condition: "system = FAS", quantity: "CEIL(total_area_sqm / 200)", outputMaterialCode: "FAS-HEAT-001", standardReference: "IS 2189 — heat detection in service areas" },
  { ruleCode: "DL-FAS-003", system: "FAS", condition: "system = FAS", quantity: "MAX(floors_above, 1) * 2", outputMaterialCode: "FAS-MCP-001", standardReference: "IS 2189 cl.4.2 — 2 manual call points per floor" },
  { ruleCode: "DL-FAS-004", system: "FAS", condition: "system = FAS", quantity: "MAX(floors_above, 1) * 2", outputMaterialCode: "FAS-HOOT-001", standardReference: "IS 2189 — audible alarm coverage per floor" },
  { ruleCode: "DL-FAS-005", system: "FAS", condition: "system = FAS", quantity: "CEIL(total_area_sqm / 120)", outputMaterialCode: "FAS-RI-001", standardReference: "IS 2189 — response indicators for enclosed rooms" },
  { ruleCode: "DL-FAS-006", system: "FAS", condition: "system = FAS", quantity: "MAX(1, CEIL(floors_above / 8))", outputMaterialCode: "FAS-PANEL-002", standardReference: "IS 2189 — main fire alarm control panel" },
  { ruleCode: "DL-FAS-007", system: "FAS", condition: "system = FAS", quantity: "ROUND(total_area_sqm * 1.5)", outputMaterialCode: "FAS-CABLE-001", standardReference: "IS 1554 — FRLS detection loop wiring" },
  { ruleCode: "DL-FAS-008", system: "FAS", condition: "system = FAS", quantity: "MAX(1, CEIL(floors_above / 8))", outputMaterialCode: "FAS-BATT-001", standardReference: "IS 2189 — 24h standby battery backup" },

  // Extinguisher
  { ruleCode: "DL-EXT-001", system: "Extinguisher", condition: "system = Extinguisher", quantity: "CEIL(total_area_sqm / 200)", outputMaterialCode: "EXT-ABC-001", standardReference: "IS 2190 — 1 ABC extinguisher per 200 sqm" },
  { ruleCode: "DL-EXT-002", system: "Extinguisher", condition: "system = Extinguisher AND building_type = Commercial", quantity: "MAX(floors_above, 1)", outputMaterialCode: "EXT-ABC-002", standardReference: "IS 2190 — 1 per floor at staircase" },
  { ruleCode: "DL-EXT-003", system: "Extinguisher", condition: "system = Extinguisher", quantity: "MAX(1, CEIL(floors_above / 2))", outputMaterialCode: "EXT-CO2-001", standardReference: "IS 2190 — CO2 cover for electrical risk" },
  { ruleCode: "DL-EXT-004", system: "Extinguisher", condition: "system = Extinguisher AND building_type <> Industrial", quantity: "CEIL(total_area_sqm / 400)", outputMaterialCode: "EXT-WCO2-001", standardReference: "IS 2190 — Class A water cover" },
  { ruleCode: "DL-EXT-005", system: "Extinguisher", condition: "system = Extinguisher", quantity: "CEIL(total_area_sqm / 400)", outputMaterialCode: "EXT-STAND-001", standardReference: "IS 2190 — stands for portable extinguishers" },

  // Hydrant
  { ruleCode: "DL-HYD-001", system: "Hydrant", condition: "system = Hydrant", quantity: "ROUND(total_area_sqm * 0.6 + MAX(floors_above, 1) * 30)", outputMaterialCode: "HYD-PIPE-100", standardReference: "IS 3844 — hydrant riser and ring main" },
  { ruleCode: "DL-HYD-002", system: "Hydrant", condition: "system = Hydrant", quantity: "MAX(floors_above, 1)", outputMaterialCode: "HYD-LH-001", standardReference: "IS 3844 — 1 landing valve per floor" },
  { ruleCode: "DL-HYD-003", system: "Hydrant", condition: "system = Hydrant", quantity: "MAX(floors_above, 1) * 2", outputMaterialCode: "HYD-HOSE-001", standardReference: "IS 3844 — 2 hoses per hydrant station" },
  { ruleCode: "DL-HYD-004", system: "Hydrant", condition: "system = Hydrant", quantity: "MAX(floors_above, 1)", outputMaterialCode: "HYD-NOZ-001", standardReference: "IS 3844 — branch pipe & nozzle per station" },
  { ruleCode: "DL-HYD-005", system: "Hydrant", condition: "system = Hydrant", quantity: "MAX(floors_above, 1)", outputMaterialCode: "HYD-HB-001", standardReference: "IS 3844 — hose box per hydrant station" },
  { ruleCode: "DL-HYD-006", system: "Hydrant", condition: "system = Hydrant AND floors_above >= 4", quantity: "1", outputMaterialCode: "HYD-PUMP-MAIN", standardReference: "NBC 2016 Part 4 — main pump for buildings >= 15m" },
  { ruleCode: "DL-HYD-007", system: "Hydrant", condition: "system = Hydrant AND floors_above >= 4", quantity: "1", outputMaterialCode: "HYD-PUMP-JOCKEY", standardReference: "NBC 2016 Part 4 — jockey pump for pressure maintenance" },
  { ruleCode: "DL-HYD-008", system: "Hydrant", condition: "system = Hydrant AND floors_above >= 4", quantity: "1", outputMaterialCode: "HYD-PUMP-DIESEL", standardReference: "NBC 2016 Part 4 — standby diesel pump" },

  // Sprinkler
  { ruleCode: "DL-SPR-001", system: "Sprinkler", condition: "system = Sprinkler", quantity: "CEIL(total_area_sqm / 12)", outputMaterialCode: "SPR-HEAD-001", standardReference: "IS 15105 — 1 head per 12 sqm (light hazard)" },
  { ruleCode: "DL-SPR-002", system: "Sprinkler", condition: "system = Sprinkler", quantity: "ROUND(total_area_sqm * 0.8)", outputMaterialCode: "SPR-PIPE-050", standardReference: "IS 15105 — branch and range piping" },
  { ruleCode: "DL-SPR-003", system: "Sprinkler", condition: "system = Sprinkler", quantity: "MAX(1, CEIL(total_area_sqm / 4000))", outputMaterialCode: "SPR-VALVE-001", standardReference: "IS 15105 — installation control (alarm) valve" },
  { ruleCode: "DL-SPR-004", system: "Sprinkler", condition: "system = Sprinkler", quantity: "MAX(floors_above, 1)", outputMaterialCode: "SPR-FDV-001", standardReference: "IS 15105 — flow switch per floor zone" },
];

/** A.07 profit margin matrix (PROGRESS §5). */
export const SEED_MARGIN_MATRIX: MarginRow[] = [
  { tier: 1, tierLabel: "Sub ₹5L", targetMarginPct: 25, floorMarginPct: 18, discountAuthority: "Self" },
  { tier: 2, tierLabel: "₹5L–20L", targetMarginPct: 22, floorMarginPct: 15, discountAuthority: "GM" },
  { tier: 3, tierLabel: "₹20L–1Cr", targetMarginPct: 20, floorMarginPct: 12, discountAuthority: "GM" },
  { tier: 4, tierLabel: ">₹1Cr", targetMarginPct: 18, floorMarginPct: 10, discountAuthority: "MD" },
];

/** Fraction of the Standard selling rate used as the material-linked install rate. */
export const INSTALL_RATE_FRACTION = 0.43;
