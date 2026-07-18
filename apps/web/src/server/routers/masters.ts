import {
  insertInstallRate,
  insertMake,
  insertMarginRow,
  insertMaterial,
  insertMaterialSpec,
  insertRule,
  loadMasterSnapshot,
  setCurrentPrice,
} from "@pebble/db";
import { evaluateCondition, evaluateQuantity, parseExpression, validateExpression } from "@pebble/expr";
import {
  APPLICABLE_STANDARDS,
  APPROVAL_STATUSES,
  DISCOUNT_AUTHORITIES,
  INSTALL_RATE_UNITS,
  MAKE_TIERS,
  MATERIAL_CATEGORIES,
  SYSTEM_TYPES,
  UNITS_OF_MEASURE,
  makeSchema,
  marginRowSchema,
  materialSchema,
  type ExprContext,
} from "@pebble/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, roleProcedure, router } from "../trpc";

function rupToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Representative enquiry contexts for the design-rule save-time dry-run. */
const SAMPLE_CONTEXTS: { label: string; ctx: ExprContext }[] = [
  {
    label: "Commercial · 4 floors · 450 sqm · FAS",
    ctx: {
      building_type: "Commercial",
      floors_above: 4,
      floor_area_sqm: 450,
      total_area_sqm: 1800,
      system: "FAS",
      make_preference: "As per Greenberg",
      applicable_standard: "IS",
      project_tier: 2,
    },
  },
  {
    label: "Residential · 2 floors · 200 sqm · Hydrant",
    ctx: {
      building_type: "Residential",
      floors_above: 2,
      floor_area_sqm: 200,
      total_area_sqm: 400,
      system: "Hydrant",
      make_preference: "Standard",
      applicable_standard: "NBC 2016",
      project_tier: 1,
    },
  },
  {
    label: "Industrial · 8 floors · 1200 sqm · Sprinkler",
    ctx: {
      building_type: "Industrial",
      floors_above: 8,
      floor_area_sqm: 1200,
      total_area_sqm: 9600,
      system: "Sprinkler",
      make_preference: "Premium",
      applicable_standard: "UL Listed",
      project_tier: 4,
    },
  },
];

function dryRun(conditionExpr: string, quantityFormula: string) {
  return SAMPLE_CONTEXTS.map(({ label, ctx }) => {
    let conditionResult: boolean | null = null;
    let quantityResult: number | null = null;
    let error: string | null = null;
    try {
      conditionResult = evaluateCondition(conditionExpr, ctx);
      // Only evaluate quantity when the condition fires (matches generation).
      quantityResult = conditionResult ? evaluateQuantity(quantityFormula, ctx) : null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { label, conditionResult, quantityResult, error };
  });
}

export const mastersRouter = router({
  /** Full resolved snapshot (materials, makes, prices, install rates, rules, margins). */
  snapshot: protectedProcedure.query(async ({ ctx }) => {
    return loadMasterSnapshot(ctx.db);
  }),

  createMaterial: roleProcedure("admin")
    .input(materialSchema)
    .mutation(async ({ ctx, input }) => {
      await insertMaterial(ctx.db, { ...input, sourceProvenance: null });
      await insertMaterialSpec(ctx.db, {
        materialCode: input.materialCode,
        applicableStandard: null,
        rating: null,
        size: null,
        certifications: [],
        complianceNotes: null,
      });
      return { ok: true };
    }),

  createMake: roleProcedure("admin").input(makeSchema).mutation(async ({ ctx, input }) => {
    await insertMake(ctx.db, input);
    return { ok: true };
  }),

  /** Supersede the current rate for (material, make) with a new open-ended row. */
  setPrice: roleProcedure("admin")
    .input(
      z.object({
        materialCode: z.string().min(1),
        makeCode: z.string().min(1),
        buyingRateRupees: z.number().nonnegative(),
        sellingRateRupees: z.number().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await setCurrentPrice(ctx.db, {
        materialCode: input.materialCode,
        makeCode: input.makeCode,
        buyingRatePaise: rupToPaise(input.buyingRateRupees),
        sellingRatePaise: rupToPaise(input.sellingRateRupees),
        validFrom: new Date(),
        createdBy: ctx.user.firebaseUid,
      });
      return { ok: true };
    }),

  createInstallRate: roleProcedure("admin")
    .input(
      z.object({
        rateCode: z.string().min(1),
        description: z.string().min(1),
        systemType: z.enum(SYSTEM_TYPES),
        linkedMaterialCode: z.string().nullable().default(null),
        rateRupees: z.number().nonnegative(),
        unit: z.enum(INSTALL_RATE_UNITS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await insertInstallRate(ctx.db, {
        rateCode: input.rateCode,
        description: input.description,
        systemType: input.systemType,
        linkedMaterialCode: input.linkedMaterialCode,
        ratePaise: rupToPaise(input.rateRupees),
        unit: input.unit,
        validFrom: new Date(),
      });
      return { ok: true };
    }),

  createMarginRow: roleProcedure("admin").input(marginRowSchema).mutation(async ({ ctx, input }) => {
    await insertMarginRow(ctx.db, input);
    return { ok: true };
  }),

  /** Validate condition + formula and dry-run them against sample enquiries. */
  validateDesignRule: roleProcedure("admin")
    .input(z.object({ conditionExpr: z.string(), quantityFormula: z.string() }))
    .mutation(({ input }) => {
      const condition = validateExpression(input.conditionExpr, "condition");
      const quantity = validateExpression(input.quantityFormula, "quantity");
      const samples =
        condition.ok && quantity.ok ? dryRun(input.conditionExpr, input.quantityFormula) : [];
      return {
        condition: { ok: condition.ok, issues: condition.issues },
        quantity: { ok: quantity.ok, issues: quantity.issues },
        samples,
      };
    }),

  /** Validate then persist a new design rule (version 1). */
  createDesignRule: roleProcedure("admin")
    .input(
      z.object({
        ruleCode: z.string().min(1),
        systemType: z.enum(SYSTEM_TYPES),
        conditionExpr: z.string().min(1),
        quantityFormula: z.string().min(1),
        outputMaterialCode: z.string().min(1),
        standardReference: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let conditionAst: unknown;
      let quantityAst: unknown;
      try {
        conditionAst = parseExpression(input.conditionExpr, "condition");
        quantityAst = parseExpression(input.quantityFormula, "quantity");
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Invalid rule expression",
        });
      }
      await insertRule(ctx.db, {
        ruleCode: input.ruleCode,
        systemType: input.systemType,
        conditionExpr: input.conditionExpr,
        conditionAst,
        quantityFormula: input.quantityFormula,
        quantityAst,
        outputMaterialCode: input.outputMaterialCode,
        standardReference: input.standardReference,
        createdBy: ctx.user.firebaseUid,
      });
      return { ok: true };
    }),

  // Expose the enum option lists so admin forms never drift from the contract.
  options: protectedProcedure.query(() => ({
    systemTypes: SYSTEM_TYPES,
    materialCategories: MATERIAL_CATEGORIES,
    unitsOfMeasure: UNITS_OF_MEASURE,
    applicableStandards: APPLICABLE_STANDARDS,
    makeTiers: MAKE_TIERS,
    approvalStatuses: APPROVAL_STATUSES,
    installRateUnits: INSTALL_RATE_UNITS,
    discountAuthorities: DISCOUNT_AUTHORITIES,
  })),
});
