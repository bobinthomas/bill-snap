# Golden corpus (§5.7)

Ground-truth labels live here so extraction changes are regression-tested, never
shipped blind. The corpus is deliberately biased toward hard cases (crumpled,
dark, angled, handwritten) and includes non-bill images to exercise the
polite-redirect path. **User uploads are never used** — bills are donated with
permission or high-fidelity mockups; the images sit in a private mirror.

## Layout

```
eval/corpus/
├── labels/*.json     # ground truth — committed, no user data
├── synthetic/        # committed OCR-safe bill renders (sample-v*) — CI-scored
├── images/           # bill image files — GITIGNORED (private mirror)
└── README.md
```

- `labels/<id>.json` — one per bill, in the exact §5.4 schema:
  `expected.amount / date / vendor / abn / gst / gst_basis / invoice_number / due_date`
  plus `should_log`. Fields the bill doesn't have are omitted (`null`).
  Optional metadata: `orientation` (`portrait`/`landscape`) and `hard: true` for
  deliberately hard cases — the harness reports composition and the hard-case
  success rate (§5.7's quick-iteration subset).
- `images/<id>.{jpg,jpeg,png,webp,heic,pdf}` — the bill photo, looked up first.
  `synthetic/<id>.png` (committed) is the fallback, so CI can score image
  labels without the private mirror. Entries with no image at all — or a
  non-raster one (PDF/HEIC, which tesseract can't read in Node) — are reported
  as skipped, never scored.
- **Image labels are scored via the OCR path**: `eval/harness.run.ts` OCRs the
  bytes with tesseract.js in Node and feeds the text through the pipeline as
  source `ocr` — the same reading path the browser demo uses. The LLaVA vision
  model cannot run in a Node eval (its `env.AI` binding is Worker-runtime-only),
  so it stays covered by unit tests (`tests/extraction.test.ts`) and the live
  demo, not the harness.
- `kind: "text"` labels carry a `text` field (e.g. `wages 500 rajesh`) instead —
  they replay the §5.3 regex path and always run without the private mirror.
- `kind: "text"` labels may carry `ocr_text` instead — the OCR text read off an
  image (line-noise headings, hyphens, boilerplate). They replay the local-OCR
  path exactly (`source: "ocr"`, machine-read, never auto-logged) and exist so
  the vendor cleanup is regression-tested without needing the private mirror or
  API quota. The harness/sweep prefer `ocr_text` over `text` when both are set.

## Composition (kept deliberately balanced)

The corpus only discriminates threshold choices if it contains the failure modes
real bills have. Maintained invariants:

- **GST balance** — roughly equal GST-inclusive / GST-exclusive / no-GST labels
  (the sweep and the GST-correctness gate need all three bases).
- **Orientations** — mix of `portrait` (phone snapshots) and `landscape`
  (scanned documents); the prompt must not prefer one.
- **Hard cases** — `hard: true` for crumpled/dark/angled/handwritten shots and
  non-bills; the report tracks the hard-case subset separately.
- **Near-duplicates** — pairs like `sample-06`/`sample-13` (same vendor, next
  invoice number) and `sample-17`/`sample-23` (same fuel pump, next fill). Each
  pair is annotated with `duplicate_of: "<partner id>"` on both sides; the
  harness asserts the §5.8 duplicate gate never false-matches a pair — once on
  the ground-truth labels (catches bad corpus data) and once on the pipeline's
  extractions (catches the parser collapsing two distinct bills into one
  vendor+amount or invoice). A false match would silently suppress the second
  bill's auto-log.
- **OCR line noise** — `sample-o1`…`sample-o11` are `ocr_text` labels whose text
  carries exactly the junk real OCR emits: multi-line headings, trailing
  hyphens, `Invoice No.`, ABN lines, boilerplate, headings-only text with no
  vendor, a word split across a line wrap (`Tel-` + `stra` → `Telstra`), a
  `Subtotal` line before the `Total` (the amount picker must take the total, not
  the first $), a stray `Total GST` line before the real total (the largest
  total-line amount wins), a `Total` label whose value sits on the line
  below it, and a dash-separated date (`03-08-2026`) that must never leak its
  digits into the amount. They pin the vendor cleanup (heading/noise
  stripping, possessive guard, alias-word fallback, line-wrap rejoin), the
  total-line amount preference, and the date-leak guard so a regression in
  `extractFromText` fails `npm run eval` before it ever ships.
  `sample-t6` pins the guard on the **typed-text** path: a mangled fragment
  (`03/08 2026`) that `findDate` misses must be stripped before the vendor
  pass too, so it can neither win the amount nor leak into the vendor.
  `sample-o12` is a real thermal card receipt (HDFC/Reliance): `Rs` currency,
  `TOTAL` OCR'd as `101AL`, and a number wall (TID/batch/card/RRN) above the
  amount — the fuzzy total match + `Rs` currency must extract the real
  `321.68`, not the first digit `5` from the page-top noise, and the date
  must survive the mangled `DATE : 09/05/2009` line.
  `sample-o13` pins the vendor picker on that same receipt shape: a
  symbol-garbage top line (`[5] Hore nan] %`) before a readable merchant block
  — the vendor must come from the FIRST clean-looking line (letter-dense, at
  least one real word), never the concatenation of every surviving token that
  used to produce the garbage wall (`Hore nan % ed } HET LN IE …`).
  `sample-o14` pins the DATE-label fallback: the `DATE :` label survives but
  the shape is mangled to a space-month (`09 May 2009`) — `findDate` must
  capture it via the label line, the guard must keep `09` from winning the
  amount, and `normaliseDate` must convert it to ISO (`2009-05-09`).
  `sample-o15`…`sample-o19` pin the words-amount fallback for Indian GST
  invoices whose numeric total row OCR'd to garbage, leaving the total only in
  words: a clean RUPEES total with a real vendor on the line above (the words
  line must become the amount, never the vendor), a paisa fraction
  (`AND NINETY PAISA`), OCR-mangled number words (`EIGHTY-FOUS` = FOUR — the
  edit-distance-1 matcher must recover the value), a DOLLARS + CENTS fraction,
  and the Indian scale with the `INR` currency word AFTER the number (which the
  amount-token strip would otherwise turn into a letter-dense fake vendor).
  `sample-o20` pins the known-vendor canonicalisation: the merchant header is
  mangled one character per word (`GUJARAT FRlGHT TOOLS` — lowercase L for
  uppercase I) — the edit-distance-1 matcher against `KNOWN_VENDORS` must
  recover `Gujarat Freight Tools` so the same store always logs the same
  vendor (and the §5.8 duplicate gate sees one spelling).

## OCR-path eval (`npm run eval:ocr`) — MEASUREMENT, not a gate

The OCR path (local tesseract → regex primary) is the demo's reading path, so
its quality is measured the same way: `eval/ocr.run.ts` OCRs every raster image
in `images/` with tesseract.js in Node, feeds the text through the real
pipeline as source `ocr`, and logs per-field confidence plus how often the
date-leak guard fires (an OCR date fragment that `findDate` missed and
`findAmount` had to strip so its digits couldn't become the amount — the
"$3.00 from 03-08-2026" bug). Report: `eval/reports/ocr-latest.json`.

No labels → no pass/fail; the point is the confidence and guard-fire numbers.
Real photos have no ground truth yet, so the committed images are synthetic
but *photo-like*: `node eval/generate-bill.mjs` (dev deps `@napi-rs/canvas`,
`tesseract.js`) draws the demo sample bill three ways — clean print, a
dash-separated date (`03-08-2026`), and a ~2°-rotated render with uneven
lighting — into `images/` (gitignored; regenerate, don't commit).

Known measurement quirks to expect (they're findings, not bugs): tesseract in
Node reads the *clean* synthetic print as `10/08/2028` (6→8) and drops the G
in `GST` → `BST` (basis then reads "none", so GST is missed), while the
rotated photo-like render reads both correctly — real OCR behaves in
dimension-dependent ways. The dash-date bill's `naiveLeak` (what the pre-fix
picker would have logged) is `$3.00` — the exact reported bug — and the guard
report shows `findDate` now handles it.

## Workers AI path — exercised in the browser demo, not Node evals

The Workers AI fallback (`env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',
…)` on the raw OCR text, when regex cannot find the amount) is a Worker
binding — it cannot be called from a Node eval, and the model is text-only, so
there is no image-API measurement like the old Gemini harness. The dev mock
(`GEMINI_MOCK=true`, `src/extraction/mock.ts`) satisfies the same
`TextBillExtractor` interface and is covered by unit tests
(`tests/mock.test.ts`) — the demo drives it live via OCR text that regex can't
parse. Real-binding behaviour is verified in `tests/extraction.test.ts` with a
stubbed `env.AI` shape (see the pipeline tests).

## Committed synthetic bills (`sample-v1`…`sample-v3`)

`node eval/generate-bill.mjs` also draws three OCR-safe bills into
`eval/corpus/synthetic/` — utilities (GST-inclusive), telecom (GST-inclusive)
and rent (GST-exclusive) — with labels in `labels/sample-v*.json`. They are the
only image labels CI can score, so they must stay deterministic:

- **OCR-safety rules** (learned the hard way): large bold fonts; amounts and
  dates avoiding the digits tesseract confuses at small sizes (the 9→3
  misread that turned `$99.95` into `$93.95`); and the words `GST`/`tax` only
  on inclusive/exclusive bills (`detectGstBasis` treats any GST mention as
  exclusive unless "inclusive" is spelled out).
- **Ground truth = what is drawn.** The label `expected` values must match the
  generator exactly — regenerate and re-run `npm run eval` when you touch
  either side.
- Vendor names must not collide with category aliases: a vendor named
  "Telstra" used to be eaten by the utilities alias (it's a vendor, not a
  category — the alias list no longer contains it).

## Adding a bill (e.g. from a support ticket — §8.2 invite)

1. Drop the image at `images/<id>.jpg` (any supported extension).
2. Add `labels/<id>.json`:

```json
{
  "id": "mytradie-01",
  "kind": "image",
  "source": "donated: tradie supplier invoice",
  "orientation": "landscape",
  "should_log": true,
  "expected": {
    "amount": 1420.0,
    "date": "2026-08-05",
    "vendor": "Blackwoods",
    "abn": "51 824 753 556",
    "gst": 129.09,
    "gst_basis": "inclusive",
    "invoice_number": "INV-9921",
    "due_date": "2026-08-26"
  }
}
```

3. Run `npm run eval` — the baseline report lands in `eval/reports/latest.json`.

## Rules

- Real bill images never enter this repo — the mirror lives in a private
  bucket and is pulled by hand per machine. The only images committed are the
  synthetic renders in `synthetic/` (generated, no user data).
- Labels are reviewed like code: a wrong ground-truth value poisons every
  regression run. For synthetic bills the generator and the label must stay in
  lockstep.
