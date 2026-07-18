import { ExprError, evaluateCondition, evaluateQuantity } from "@pebble/expr";
import type {
  AppliedRule,
  BomLine,
  DesignRule,
  GenerationWarning,
  MasterSnapshot,
  Material,
} from "@pebble/shared";
import { buildExprContext, type GenerationInput } from "./context";

/**
 * B.01 — Design logic. For each requested system, evaluate every active rule's
 * condition against the enquiry context; for those that fire, evaluate the
 * quantity formula and emit one BOM line. Rule failures become warnings, never
 * exceptions. Output is deterministic: systems follow the requested order,
 * rules within a system are processed in rule_code order.
 */

export interface BomResult {
  lines: BomLine[];
  appliedRules: AppliedRule[];
  warnings: GenerationWarning[];
}

function byRuleCode(a: DesignRule, b: DesignRule): number {
  return a.ruleCode < b.ruleCode ? -1 : a.ruleCode > b.ruleCode ? 1 : 0;
}

export function generateBom(input: GenerationInput, snapshot: MasterSnapshot): BomResult {
  const lines: BomLine[] = [];
  const appliedRules: AppliedRule[] = [];
  const warnings: GenerationWarning[] = [];

  const materialByCode = new Map<string, Material>(
    snapshot.materials.map((m) => [m.materialCode, m]),
  );

  for (const system of input.systemsRequired) {
    const ctx = buildExprContext(input, system);
    const systemRules = snapshot.rules
      .filter((r) => r.active && r.systemType === system)
      .sort(byRuleCode);

    let firedForSystem = 0;

    for (const rule of systemRules) {
      let conditionMet: boolean;
      try {
        conditionMet = evaluateCondition(rule.conditionExpr, ctx);
      } catch (err) {
        warnings.push({
          kind: "RULE_EVAL_ERROR",
          message: `Rule ${rule.ruleCode} condition failed: ${errMessage(err)}`,
          ruleCode: rule.ruleCode,
          materialCode: rule.outputMaterialCode,
          systemType: system,
        });
        continue;
      }
      if (!conditionMet) continue;

      let quantity: number;
      try {
        quantity = evaluateQuantity(rule.quantityFormula, ctx);
      } catch (err) {
        warnings.push({
          kind: "RULE_EVAL_ERROR",
          message: `Rule ${rule.ruleCode} quantity failed: ${errMessage(err)}`,
          ruleCode: rule.ruleCode,
          materialCode: rule.outputMaterialCode,
          systemType: system,
        });
        continue;
      }

      const material = materialByCode.get(rule.outputMaterialCode);
      if (!material) {
        warnings.push({
          kind: "RULE_EVAL_ERROR",
          message: `Rule ${rule.ruleCode} references unknown material ${rule.outputMaterialCode}`,
          ruleCode: rule.ruleCode,
          materialCode: rule.outputMaterialCode,
          systemType: system,
        });
        continue;
      }
      if (!material.active) {
        warnings.push({
          kind: "MATERIAL_INACTIVE",
          message: `Rule ${rule.ruleCode} output material ${material.materialCode} is inactive`,
          ruleCode: rule.ruleCode,
          materialCode: material.materialCode,
          systemType: system,
        });
        continue;
      }

      // The rule matched the enquiry even if it yields no quantity here.
      firedForSystem += 1;
      if (quantity <= 0) continue;

      lines.push({
        systemType: system,
        materialCode: material.materialCode,
        materialName: material.materialName,
        unit: material.unitOfMeasure,
        qty: quantity,
        ruleCode: rule.ruleCode,
        ruleId: rule.ruleId,
        standardReference: rule.standardReference,
      });
      appliedRules.push({
        ruleId: rule.ruleId,
        ruleCode: rule.ruleCode,
        ruleVersion: rule.ruleVersion,
        conditionExpr: rule.conditionExpr,
        quantityFormula: rule.quantityFormula,
        quantityResult: quantity,
        outputMaterialCode: material.materialCode,
        standardReference: rule.standardReference,
      });
    }

    if (firedForSystem === 0) {
      warnings.push({
        kind: "NO_RULES_MATCHED",
        message: `No design rule matched for system ${system}`,
        ruleCode: null,
        materialCode: null,
        systemType: system,
      });
    }
  }

  return { lines, appliedRules, warnings };
}

function errMessage(err: unknown): string {
  if (err instanceof ExprError) return err.issues.map((i) => i.message).join("; ");
  return err instanceof Error ? err.message : String(err);
}
