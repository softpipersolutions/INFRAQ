# Eval fixtures

Each subdirectory under `eval/fixtures/` is one hand-labeled source document
for the AI extraction eval harness (`eval/run-extraction-eval.ts`, run via
`pnpm --filter @pebble/ai eval:extraction`). A fixture directory contains a
single `labels.json` file.

`labels.json` is a `FixtureFile`: an `EvalExpectation` (see
`../../src/ingest/eval-score.ts`) plus two harness-only fields:

- `sourceFile` (required): the labeled PDF's path, **relative to the repo
  root** (e.g. `"Amitabh Fire Safety BOQ Data/FF-149 ... .pdf"`). The harness
  resolves this against the repo root it discovers by walking up from this
  file looking for `pnpm-workspace.yaml`.
- `totalPages` (optional): the document's real page count. The harness sends
  the *whole* PDF in a single `extractPageWindow` call (see the divergence
  note at the top of `run-extraction-eval.ts`) and needs a page count only to
  phrase the prompt's page range; if omitted it falls back to the highest
  page number referenced anywhere in `labeledPages` / `expectedLines`.

## `EvalExpectation` fields

- `labeledPages: number[]` — the printed page numbers a human actually
  reviewed. **Precision is only scored over extracted lines on these pages**
  — an extra line on an unlabeled page is neither rewarded nor punished,
  because nobody checked that page.
- `expectedLines: ExpectedLine[]` — the line items a human found on the
  labeled pages. Each `ExpectedLine`:
  - `page` (required): the line's absolute printed page number.
  - `descriptionContains` (required): a substring (case- and
    whitespace-insensitive) the extracted `description` must contain. Pick a
    fragment that is unique among nearby rows — `matchLine` uses `page` +
    `qty` + `unitRateRupees` + this substring together to identify "this is
    the row I labeled", so it does not need to be the whole description.
  - `qty`, `unitRateRupees` (optional): when given, must match the extracted
    line exactly (`qty`) or within 0.5% (`unitRateRupees`) for a match.
  - `slNo`, `makeRaw`, `unitRaw`, `amountRupees`, `rateKind`, `section`
    (optional): recorded for `fieldAccuracy` reporting (`make`/`unit`/
    `rateKind`) and for future use — they do not gate whether a line counts
    as matched. Omit a field (rather than setting it to `null`) when you are
    not confident enough in the source to assert it — an omitted field is
    simply not scored, instead of being scored against a guess.
- `expectMeta?: Partial<DocMeta>` (optional) — scalar `docMetaSchema` fields
  to check against `extractDocMeta`'s output (e.g. `attention`,
  `projectName`, `docDateISO`, `revision`, `sourceEntityGuess`, `docKind`,
  `gstMentioned`, `grandTotalRupees`). Stick to scalars (string / number /
  boolean) — array fields like `systemsMentioned` or `sections` aren't a good
  fit for exact-match scoring since the model's ordering isn't guaranteed.

## Full example

```json
{
  "sourceFile": "Amitabh Fire Safety BOQ Data/FF-149 Experio Unit Fire Sprinkler System & FAS (26122025 R2).pdf",
  "totalPages": 2,
  "labeledPages": [1],
  "expectMeta": {
    "attention": "Yamini Sharma",
    "projectName": "COMMERCIAL UNIT, EXPORIO BUILDING, LUCKNOW, UP",
    "docDateISO": "2025-12-26",
    "revision": "02",
    "sourceEntityGuess": "Greenberg Enterprises",
    "docKind": "proposal",
    "gstMentioned": true,
    "grandTotalRupees": 83909.8
  },
  "expectedLines": [
    {
      "page": 1,
      "slNo": "A1",
      "descriptionContains": "class 'c' 50 mm",
      "makeRaw": "Jindal (ISI)",
      "qty": 6,
      "unitRaw": "mtr",
      "unitRateRupees": 590,
      "amountRupees": 3540,
      "rateKind": "SITC",
      "section": "A. SPRINKLER SYSTEM"
    }
  ]
}
```

See `ff-149-experio/labels.json` for the complete, real fixture this example
is drawn from (11 hand-labeled line items across two BOQ sections on page 1
of a real Greenberg proposal).

## Adding a fixture

1. Pick a source PDF from `Amitabh Fire Safety BOQ Data/` and read the pages
   you intend to label (the `pdf` skill / `pypdf`/`pdfplumber` are fine for
   spot-checking what a human would see — the eval itself always calls the
   real Gemini model, never these tools).
2. Create `eval/fixtures/<short-slug>/labels.json` with the shape above.
3. Run `GOOGLE_GENERATIVE_AI_API_KEY=... pnpm --filter @pebble/ai
   eval:extraction` and read the printed per-doc precision/recall/mismatches
   to sanity-check your labels before trusting them as a regression gate.
