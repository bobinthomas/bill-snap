/**
 * §5.7 threshold sweep ("Threshold tuning").
 *
 * Sweeps the §5.4 high thresholds (amount 0.80–0.95, date 0.75–0.95, vendor
 * 0.60–0.90) across the golden corpus and reports every combination that clears
 * the §5.7 targets, plus a recommended operating point: the strictest passing
 * gate (highest threshold sum — fewest auto-log/confirm-screen decisions made
 * on low confidence), tie-broken by success rate.
 *
 * The corpus is extracted ONCE per entry (one regex pass each); each combo only
 * re-runs `classify` (§5.4 gating) and the threshold-dependent accuracy pool,
 * so the sweep is cheap. The chosen point then ships via env vars (§5.4) with
 * no deploy.
 *
 * Run: `npm run sweep` — writes eval/reports/sweep-latest.json and exits
 * non-zero if NO combination clears the targets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { createWorker, type Worker } from "tesseract.js";
import { it } from "vitest";
import { loadConfig } from "../src/config";
import { classify, type GateThresholds } from "../src/extraction/gate";
import { createExtractionService, type ExtractionOutcome } from "../src/extraction/pipeline";
import {
  aggregate,
  computeCriteria,
  findImage,
  loadDevVars,
  loadLabels,
  REPORT_DIR,
  scoreEntry,
  TARGETS,
  type Aggregate,
  type CorpusEntry,
} from "./lib";

// Sweep space for the §5.4 high thresholds; low thresholds stay at config defaults.
const AMOUNT_HIGH = [0.8, 0.85, 0.9, 0.95];
const DATE_HIGH = [0.75, 0.8, 0.85, 0.9, 0.95];
const VENDOR_HIGH = [0.6, 0.7, 0.75, 0.8, 0.9];

interface Combo {
  amountHigh: number;
  dateHigh: number;
  vendorHigh: number;
}

interface ComboResult extends Combo {
  agg: Aggregate;
  pass: boolean;
}

it(
  "sweeps the §5.4 thresholds and finds the operating point",
  async () => {
  loadDevVars();
  const config = loadConfig(env);
  const service = createExtractionService(config);

  const labels = loadLabels();
  // One extraction pass per entry; each combo only re-gates and re-pools.
  const entries: Array<{ entry: CorpusEntry; outcome: ExtractionOutcome }> = [];
  const skippedMissingImage: string[] = [];
  // Image labels are OCR'd in Node (the harness's image branch — see
  // harness.run.ts for why the vision model can't run in a Node eval).
  let ocrWorker: Worker | null = null;
  for (const entry of labels) {
    if (entry.kind === "text" && entry.ocr_text !== undefined) {
      // OCR-noise labels replay the local-OCR path (source "ocr").
      entries.push({ entry, outcome: await service.run({ ocrText: entry.ocr_text, gstRegistered: true }) });
    } else if (entry.kind === "text" && entry.text !== undefined) {
      entries.push({ entry, outcome: await service.run({ text: entry.text, gstRegistered: true }) });
    } else {
      const image = findImage(entry.id);
      if (!image) {
        skippedMissingImage.push(entry.id);
        continue;
      }
      // Non-raster mirror images (PDF/HEIC) can't be OCR'd in Node — skip.
      if (!image.mime.startsWith("image/")) {
        skippedMissingImage.push(entry.id);
        continue;
      }
      ocrWorker ??= await createWorker("eng");
      const { data } = await ocrWorker.recognize(image.bytes);
      entries.push({ entry, outcome: await service.run({ ocrText: (data.text ?? "").trim(), gstRegistered: true }) });
    }
  }
  await ocrWorker?.terminate();

  if (entries.length === 0) {
    throw new Error(
      "sweep: nothing scored — no text/OCR labels and no images in eval/corpus/images/ (private mirror). See eval/corpus/README.md.",
    );
  }

  const combos: Combo[] = [];
  for (const amountHigh of AMOUNT_HIGH) {
    for (const dateHigh of DATE_HIGH) {
      for (const vendorHigh of VENDOR_HIGH) combos.push({ amountHigh, dateHigh, vendorHigh });
    }
  }

  const results: ComboResult[] = combos.map((combo) => {
    const thresholds: GateThresholds = {
      amountHigh: combo.amountHigh,
      amountLow: config.extraction.amountLow,
      dateHigh: combo.dateHigh,
      vendorHigh: combo.vendorHigh,
    };
    const scored = entries.map(({ entry, outcome }) => {
      const gate = classify(outcome.extraction, thresholds);
      return scoreEntry(entry, { ...outcome, gate });
    });
    const agg = aggregate(scored, {
      amount: combo.amountHigh,
      date: combo.dateHigh,
      vendor: combo.vendorHigh,
    });
    // n/a criteria (no labelled data) pass; any real failure fails the combo.
    const pass = Object.values(computeCriteria(agg)).every((c) => c.value === null || c.pass);
    return { ...combo, agg, pass };
  });

  const passing = results.filter((r) => r.pass);
  // Recommended: strictest passing gate (highest threshold sum), tie-broken by success rate.
  const recommended = [...passing].sort((a, b) => {
    const sa = a.amountHigh + a.dateHigh + a.vendorHigh;
    const sb = b.amountHigh + b.dateHigh + b.vendorHigh;
    if (sa !== sb) return sb - sa;
    return (b.agg.successRate ?? 0) - (a.agg.successRate ?? 0);
  })[0] ?? null;

  const defaults: Combo = {
    amountHigh: config.extraction.amountHigh,
    dateHigh: config.extraction.dateHigh,
    vendorHigh: config.extraction.vendorHigh,
  };
  const defaultsResult = results.find(
    (r) => r.amountHigh === defaults.amountHigh && r.dateHigh === defaults.dateHigh && r.vendorHigh === defaults.vendorHigh,
  ) ?? null;

  const report = {
    generatedAt: new Date().toISOString(),
    config: {},
    corpus: { total: labels.length, scored: entries.length, skippedMissingImage },
    targets: TARGETS,
    defaults: { ...defaults, pass: defaultsResult?.pass ?? false },
    combos: results.map((r) => ({
      amountHigh: r.amountHigh,
      dateHigh: r.dateHigh,
      vendorHigh: r.vendorHigh,
      pass: r.pass,
      successRate: r.agg.successRate,
      amountAccuracy: r.agg.field.amount.accuracy,
      dateAccuracy: r.agg.field.date.accuracy,
      vendorAccuracy: r.agg.field.vendor.accuracy,
      gst: r.agg.gst,
    })),
    recommended: recommended
      ? { amountHigh: recommended.amountHigh, dateHigh: recommended.dateHigh, vendorHigh: recommended.vendorHigh }
      : null,
    passingCount: passing.length,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "sweep-latest.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`\n§5.7 sweep — corpus ${labels.length} entries (${entries.length} scored, ${skippedMissingImage.length} missing image)`);
  console.log(`${results.length} threshold combos × one extraction pass each`);
  console.log(`Defaults (amount ${defaults.amountHigh} / date ${defaults.dateHigh} / vendor ${defaults.vendorHigh}): ${defaultsResult?.pass ? "PASSES" : "fails or n/a"}`);
  console.log(`Passing combos: ${passing.length} of ${results.length}`);
  if (recommended) {
    console.log(`Recommended operating point: amount ≥ ${recommended.amountHigh}, date ≥ ${recommended.dateHigh}, vendor ≥ ${recommended.vendorHigh}`);
    console.log(`  → success rate ${fmt(recommended.agg.successRate)} (target ${(TARGETS.successRate * 100).toFixed(0)}%)`);
    console.log(`  → amount ${fmt(recommended.agg.field.amount.accuracy)} | date ${fmt(recommended.agg.field.date.accuracy)} | vendor ${fmt(recommended.agg.field.vendor.accuracy)}`);
    console.log(`Report: eval/reports/sweep-latest.json\n`);
  }

  if (passing.length === 0) {
    throw new Error(
      "sweep: no threshold combination clears the §5.7 targets — see eval/reports/sweep-latest.json. The extraction itself is below spec at every gate; fix the prompt/regex before tuning thresholds.",
    );
  }
  },
  120_000,
);

function fmt(value: number | null): string {
  return value === null ? "n/a" : (value * 100).toFixed(1) + "%";
}
