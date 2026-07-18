import type { MasterSnapshot } from "@pebble/shared";
import { formatINR } from "@pebble/shared";

/**
 * Master-data digest for the Claude lane (spec §4.4, prompt caching).
 *
 * The digest is a compact, deterministic text rendering of the current masters
 * that goes into the system prompt behind a cache_control breakpoint. Because a
 * content hash keys the cache, the digest is regenerated only when masters
 * actually change — so cache hits persist across every chat until an admin
 * edits a rate or rule.
 *
 * The model reads this to explain and reason ("why 14 detectors?", "what makes
 * are approved?") — it NEVER computes prices from it; money always comes from
 * the engines.
 */

export function buildMasterDigest(snapshot: MasterSnapshot): string {
  const lines: string[] = [];
  lines.push("# Greenberg master data (current)");
  lines.push("");

  lines.push("## Margin tiers");
  for (const m of [...snapshot.marginMatrix].sort((a, b) => a.tier - b.tier)) {
    lines.push(
      `- Tier ${m.tier} (${m.tierLabel}): target ${m.targetMarginPct}%, floor ${m.floorMarginPct}%, authority ${m.discountAuthority}`,
    );
  }
  lines.push("");

  const makesByMaterial = groupBy(snapshot.makes, (k) => k.materialCode);
  const priceByKey = new Map(snapshot.prices.map((p) => [`${p.materialCode}|${p.makeCode}`, p]));
  const installByMaterial = new Map(
    snapshot.installRates
      .filter((r) => r.linkedMaterialCode)
      .map((r) => [r.linkedMaterialCode as string, r]),
  );

  lines.push("## Materials (with approved makes and current SITC-basis rates)");
  for (const material of [...snapshot.materials].sort(byField("materialCode"))) {
    const flag = material.active ? "" : " [INACTIVE]";
    lines.push(`- ${material.materialCode} — ${material.materialName} (${material.systemType}, ${material.unitOfMeasure})${flag}`);
    const makes = (makesByMaterial.get(material.materialCode) ?? []).sort(byField("makeCode"));
    for (const mk of makes) {
      const price = priceByKey.get(`${material.materialCode}|${mk.makeCode}`);
      const rate = price ? formatINR(price.sellingRatePaise) : "no price";
      lines.push(`    · ${mk.brandName} [${mk.tier}/${mk.approvalStatus}] supply ${rate}`);
    }
    const install = installByMaterial.get(material.materialCode);
    if (install) lines.push(`    · install: ${formatINR(install.ratePaise)} ${install.unit}`);
  }
  lines.push("");

  lines.push("## Design rules (A.06)");
  for (const r of [...snapshot.rules].sort(byField("ruleCode"))) {
    lines.push(
      `- ${r.ruleCode} [${r.systemType}]: IF ${r.conditionExpr} THEN qty = ${r.quantityFormula} of ${r.outputMaterialCode}` +
        (r.standardReference ? ` (${r.standardReference})` : ""),
    );
  }

  return lines.join("\n");
}

/**
 * Stable content hash of the masters (FNV-1a over a canonicalised projection).
 * Used as the prompt-cache key: identical masters → identical hash → cache hit.
 */
export function masterDigestHash(snapshot: MasterSnapshot): string {
  const canonical = JSON.stringify({
    materials: [...snapshot.materials].sort(byField("materialCode")),
    makes: [...snapshot.makes].sort(byField("makeCode")),
    prices: [...snapshot.prices].sort(byField("priceId")),
    installRates: [...snapshot.installRates].sort(byField("rateCode")),
    rules: [...snapshot.rules].sort(byField("ruleId")),
    marginMatrix: [...snapshot.marginMatrix].sort((a, b) => a.tier - b.tier),
  });
  return fnv1a(canonical);
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

function byField<T, K extends keyof T>(field: K): (a: T, b: T) => number {
  return (a, b) => {
    const av = String(a[field]);
    const bv = String(b[field]);
    return av < bv ? -1 : av > bv ? 1 : 0;
  };
}
