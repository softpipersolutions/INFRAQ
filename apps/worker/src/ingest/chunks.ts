import { formatINR, sumPaise, type ChunkKind } from "@pebble/shared";
import type { NormalizedLine } from "./normalize";

/**
 * Pure retrieval-chunk building (PLAN §4.5 — `rag_chunks`). Turns one
 * document's normalized lines + doc-level metadata into `doc_summary` /
 * `boq_section` / `terms` chunk drafts, each capped at 6000 chars and (for
 * `boq_section`) 40 lines so no single chunk blows an embedding/context
 * budget. Staging/dedup (turning these + lines into `StagedMaterialBundle`
 * proposals) is WP3's job — this stops at rendering text chunks.
 */

export interface ChunkDocMeta {
  clientName: string | null;
  projectName: string | null;
  docDateISO: string | null;
  revision: string | null;
  sourceEntity: string | null;
  docKind: string;
  summary: string;
  systems: string[];
  grandTotalPaise: number | null;
}

export interface ChunkDraft {
  chunkKind: ChunkKind;
  content: string;
  metadata: Record<string, unknown>;
}

export interface BuildChunksArgs {
  meta: ChunkDocMeta;
  lines: NormalizedLine[];
  termsText: string | null;
  fileRef: string | null;
  filename: string;
  docType: string;
}

const MAX_CHUNK_CHARS = 6000;
const MAX_SECTION_LINES = 40;
const MAX_TERMS_WORDS = 400;
const UNSECTIONED = "UNSECTIONED";

function capChars(text: string, max = MAX_CHUNK_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Fields every chunk's metadata carries, regardless of kind. */
function baseMetadata(args: BuildChunksArgs): Record<string, unknown> {
  return {
    fileRef: args.fileRef,
    filename: args.filename,
    docType: args.docType,
    docDateISO: args.meta.docDateISO,
    revision: args.meta.revision,
    sourceEntity: args.meta.sourceEntity,
    client: args.meta.clientName,
    project: args.meta.projectName,
    systems: args.meta.systems,
    grandTotalPaise: args.meta.grandTotalPaise,
  };
}

/** `Sl | description — make | qty unit @ ₹rate = ₹amount` */
function renderLine(line: NormalizedLine): string {
  const sl = line.slNo ?? "-";
  const make = line.brand.normalized ?? line.brand.raw;
  const desc = make ? `${line.description} — ${make}` : line.description;
  const unit = line.unit.normalized ?? line.unitRaw ?? "-";
  const qty = line.qty ?? 0;
  const rate = line.sellPaise !== null ? formatINR(line.sellPaise) : "—";
  const amount = line.amountPaise !== null ? formatINR(line.amountPaise) : "—";
  return `${sl} | ${desc} | ${qty} ${unit} @ ${rate} = ${amount}`;
}

/** Greedily pack rendered lines into groups respecting both a line-count and a char cap. */
function packLines(lines: string[], maxLines: number, maxChars: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const line of lines) {
    const lineChars = line.length + 1;
    const wouldOverflow = current.length > 0 && (current.length + 1 > maxLines || currentChars + lineChars > maxChars);
    if (wouldOverflow) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += lineChars;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildDocSummaryChunk(args: BuildChunksArgs): ChunkDraft {
  const { meta } = args;
  const facts = [
    `Client: ${meta.clientName ?? "—"} | Project: ${meta.projectName ?? "—"} | Date: ${meta.docDateISO ?? "—"} | Revision: ${meta.revision ?? "—"} | Source: ${meta.sourceEntity ?? "—"}`,
    `Doc kind: ${meta.docKind} | Systems: ${meta.systems.length > 0 ? meta.systems.join(", ") : "—"} | Grand Total: ${meta.grandTotalPaise !== null ? formatINR(meta.grandTotalPaise) : "—"}`,
  ].join("\n");
  const content = capChars([meta.summary, "", facts].join("\n"));
  return { chunkKind: "doc_summary", content, metadata: baseMetadata(args) };
}

function sectionKeyFor(line: NormalizedLine): string {
  return line.section ?? line.systemGuess ?? UNSECTIONED;
}

function buildBoqSectionChunks(args: BuildChunksArgs): ChunkDraft[] {
  const bySection = new Map<string, NormalizedLine[]>();
  for (const line of args.lines) {
    const key = sectionKeyFor(line);
    const bucket = bySection.get(key);
    if (bucket) bucket.push(line);
    else bySection.set(key, [line]);
  }

  const chunks: ChunkDraft[] = [];
  for (const [section, sectionLines] of bySection) {
    const rendered = sectionLines.map(renderLine);
    const groups = packLines(rendered, MAX_SECTION_LINES, MAX_CHUNK_CHARS);

    let cursor = 0;
    for (const group of groups) {
      const groupLines = sectionLines.slice(cursor, cursor + group.length);
      cursor += group.length;

      const pages = groupLines.map((l) => l.page).filter((p) => p > 0);
      const pageStart = pages.length > 0 ? Math.min(...pages) : 0;
      const pageEnd = pages.length > 0 ? Math.max(...pages) : 0;
      const systems = Array.from(
        new Set(groupLines.map((l) => l.systemGuess).filter((s): s is NonNullable<typeof s> => s !== null)),
      );
      const sectionTotalPaise = sumPaise(
        groupLines.map((l) => l.amountPaise).filter((p): p is number => p !== null),
        "buildChunks.sectionTotalPaise",
      );

      chunks.push({
        chunkKind: "boq_section",
        content: capChars(group.join("\n")),
        metadata: {
          ...baseMetadata(args),
          section,
          systems,
          pageStart,
          pageEnd,
          lineCount: groupLines.length,
          sectionTotalPaise,
        },
      });
    }
  }
  return chunks;
}

function buildTermsChunk(args: BuildChunksArgs): ChunkDraft | null {
  const text = args.termsText?.trim();
  if (!text) return null;
  const words = text.split(/\s+/);
  const capped = words.length > MAX_TERMS_WORDS ? words.slice(0, MAX_TERMS_WORDS).join(" ") : text;
  return { chunkKind: "terms", content: capChars(capped), metadata: baseMetadata(args) };
}

export function buildChunks(args: BuildChunksArgs): ChunkDraft[] {
  const chunks: ChunkDraft[] = [buildDocSummaryChunk(args)];
  chunks.push(...buildBoqSectionChunks(args));
  const terms = buildTermsChunk(args);
  if (terms) chunks.push(terms);
  return chunks;
}
