/**
 * §5.7 extraction eval harness.
 *
 * Replays the golden corpus (`eval/corpus/labels/*.json`) through the REAL
 * extraction pipeline (regex primary → validation → gating) and scores it
 * against the §5.7 pass criteria (see `eval/lib.ts` for the scoring rules).
 *
 * Text/ocr_text labels replay their text directly. Image labels are OCR'd with
 * tesseract.js in Node (the same OCR → regex path the browser demo uses) — the
 * LLaVA vision model needs the `env.AI` binding, which only exists in the
 * Worker runtime, so Node evals cannot run it. Images resolve from the private
 * mirror (`eval/corpus/images/`) first, then the committed synthetic renders
 * (`eval/corpus/synthetic/`); non-raster mirror images (PDF/HEIC) are skipped.
 *
 * Run: `npm run eval`. Writes the baseline to `eval/reports/latest.json` and
 * exits non-zero when any data-bearing criterion fails — a change ships only if
 * it clears these gates (§5.7).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { createWorker, type Worker } from "tesseract.js";
import { it } from "vitest";
import { loadConfig } from "../src/config";
import { createExtractionService } from "../src/extraction/pipeline";
import {
  aggregate,
  checkDuplicatePairs,
  computeCriteria,
  findImage,
  loadDevVars,
  loadLabels,
  REPORT_DIR,
  scoreEntry,
  TARGETS,
  type Aggregate,
  type ScoredEntry,
} from "./lib";

it(
  "replays the golden corpus and writes the §5.7 baseline report",
  async () => {
    loadDevVars();
    const config = loadConfig(env);
    const service = createExtractionService(config);

    const labels = loadLabels();
    const scored: ScoredEntry[] = [];
    const skippedMissingImage: string[] = [];
    let ocrWorker: Worker | null = null;
    try {
      for (const entry of labels) {
        if (entry.kind === "text" && entry.ocr_text !== undefined) {
          // OCR-noise labels replay the local-OCR path (source "ocr").
          const outcome = await service.run({ ocrText: entry.ocr_text, gstRegistered: true });
          scored.push(scoreEntry(entry, outcome));
        } else if (entry.kind === "text" && entry.text !== undefined) {
          const outcome = await service.run({ text: entry.text, gstRegistered: true });
          scored.push(scoreEntry(entry, outcome));
        } else {
          const image = findImage(entry.id);
          if (!image) {
            skippedMissingImage.push(entry.id);
            continue;
          }
          // tesseract can't rasterize PDF/HEIC mirror images — skip them rather
          // than scoring a guaranteed failure.
          if (!image.mime.startsWith("image/")) {
            skippedMissingImage.push(entry.id);
            continue;
          }
          ocrWorker ??= await createWorker("eng");
          const { data } = await ocrWorker.recognize(image.bytes);
          const outcome = await service.run({ ocrText: (data.text ?? "").trim(), gstRegistered: true });
          scored.push(scoreEntry(entry, outcome));
        }
      }
    } finally {
      await ocrWorker?.terminate();
    }

    const agg = aggregate(scored, {
      amount: config.extraction.amountHigh,
      date: config.extraction.dateHigh,
      vendor: config.extraction.vendorHigh,
    });
    const criteria = computeCriteria(agg);

    // §5.8 duplicate gate: near-duplicate pairs must never false-match.
    const scoredByLabel = new Map(scored.map((s) => [s.id, s]));
    const duplicateGate = checkDuplicatePairs(labels, scoredByLabel);

    const breakdown = { inclusive: 0, exclusive: 0, none: 0, portrait: 0, landscape: 0, hard: 0 };
    for (const l of labels) {
      const basis = l.expected.gst_basis;
      if (basis === "inclusive" || basis === "exclusive" || basis === "none") breakdown[basis]++;
      if (l.orientation === "portrait") breakdown.portrait++;
      if (l.orientation === "landscape") breakdown.landscape++;
      if (l.hard) breakdown.hard++;
    }

    const report = {
      generatedAt: new Date().toISOString(),
      config: { mock: config.geminiMock },
      corpus: { total: labels.length, scored: scored.length, skippedMissingImage, breakdown },
      thresholds: {
        amountHigh: config.extraction.amountHigh,
        dateHigh: config.extraction.dateHigh,
        vendorHigh: config.extraction.vendorHigh,
      },
      metrics: {
        successRate: agg.successRate,
        successTarget: TARGETS.successRate,
        hardCase: agg.hardCase,
        fieldAccuracy: agg.field,
        gating: agg.gating,
        gst: agg.gst,
        duplicateGate,
        nonBills:
          agg.nonBills.length > 0
            ? { n: agg.nonBills.length, notAutoLogged: agg.nonBills.filter((s) => s.notAutoLogged === true).length }
            : null,
      },
      criteria,
      failures: agg.failures.map((s) => ({
        id: s.id,
        mode: s.mode,
        gate: s.gate,
        source: s.source,
        reasons: s.reasons,
        actual: s.actual,
        extraction: s.extraction,
      })),
    };

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, "latest.json"), JSON.stringify(report, null, 2) + "\n");

    printSummary(labels.length, scored.length, skippedMissingImage.length, config.geminiMock, agg, criteria, breakdown, duplicateGate);

    if (scored.length === 0) {
      throw new Error(
        "eval: nothing scored — no text/OCR labels and no images in eval/corpus/images/ (private mirror). See eval/corpus/README.md.",
      );
    }
    const failed = Object.entries(criteria).filter(([, c]) => c.value !== null && !c.pass);
    const duplicateFailed =
      duplicateGate.pairs > 0 && (duplicateGate.labelMatches.length > 0 || duplicateGate.extractionMatches.length > 0);
    if (failed.length > 0 || duplicateFailed) {
      const names = failed.map(([name]) => name).join(", ");
      const dup = duplicateFailed
        ? `; duplicate gate false-matches: ${[...duplicateGate.labelMatches, ...duplicateGate.extractionMatches].join(", ")}`
        : "";
      throw new Error(
        `eval: below §5.7 targets (${names || "—"})${dup} — see eval/reports/latest.json for failures.`,
      );
    }
  },
  120_000,
);

function printSummary(
  total: number,
  scoredCount: number,
  skipped: number,
  mock: boolean,
  agg: Aggregate,
  criteria: ReturnType<typeof computeCriteria>,
  breakdown: { inclusive: number; exclusive: number; none: number; portrait: number; landscape: number; hard: number },
  duplicateGate: ReturnType<typeof checkDuplicatePairs>,
): void {
  console.log(`\n§5.7 eval — corpus ${total} entries (${scoredCount} scored, ${skipped} skipped: no image / non-raster)`);
  console.log(`Parsers: regex primary + ${mock ? "mock Workers AI (canned)" : "Workers AI binding when available"}`);
  console.log(`Composition: GST in ${breakdown.inclusive} / ex ${breakdown.exclusive} / none ${breakdown.none} | ${breakdown.portrait}p / ${breakdown.landscape}l | ${breakdown.hard} hard cases\n`);
  for (const s of [...agg.bills, ...agg.nonBills]) {
    const mark = s.success || s.notAutoLogged === true ? "✓" : "✗";
    console.log(`  ${mark} ${s.id} (${s.mode}, ${s.gate})${s.reasons.length > 0 ? " — " + s.reasons.join("; ") : ""}`);
  }
  console.log(`\n  success rate: ${agg.successRate === null ? "n/a" : (agg.successRate * 100).toFixed(1) + "%"} (target ${(TARGETS.successRate * 100).toFixed(0)}%)`);
  console.log(`  hard-case success: ${agg.hardCase.successRate === null ? "n/a" : (agg.hardCase.successRate * 100).toFixed(1) + "%"} (n=${agg.hardCase.n}) — the §5.7 quick-iteration subset`);
  for (const [name, f] of Object.entries(agg.field)) {
    console.log(`  ${name}: ${f.accuracy === null ? "n/a" : (f.accuracy * 100).toFixed(1) + "%"} (n=${f.n}, target ${(TARGETS[name as keyof typeof TARGETS] * 100).toFixed(0)}%)`);
  }
  console.log(`  gst: ${agg.gst.n === 0 ? "n/a" : `${agg.gst.correct}/${agg.gst.n} within 1c`}`);
  console.log(`  gating: ${JSON.stringify(agg.gating)}`);
  const dupPass =
    duplicateGate.pairs === 0 || (duplicateGate.labelMatches.length === 0 && duplicateGate.extractionMatches.length === 0);
  const dupDetail =
    duplicateGate.pairs === 0
      ? "n/a (no near-duplicate pairs)"
      : `${duplicateGate.pairs} pairs, ${duplicateGate.checked} extraction-checked, 0 false matches`;
  console.log(`  §5.8 duplicate gate: ${dupPass ? "PASS" : "FAIL"} (${dupDetail})`);
  for (const [name, c] of Object.entries(criteria)) {
    console.log(`  criterion ${name}: ${c.pass ? "PASS" : c.value === null ? "n/a" : "FAIL"} (${c.value === null ? "no data" : (c.value * 100).toFixed(1) + "%"} / ${(c.target * 100).toFixed(0)}%)`);
  }
  console.log(`Report: eval/reports/latest.json\n`);
}
