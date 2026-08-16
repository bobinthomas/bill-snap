/**
 * §5.7 OCR-path eval (MEASUREMENT — not a pass gate).
 *
 * OCRs every raster image in `eval/corpus/images/` (or a single fresh photo via
 * `OCR_PHOTO=<path>`) with tesseract.js in Node, feeds the text through the REAL
 * pipeline as source "ocr", and reports per-field confidence plus how often the
 * date-leak guard fires — i.e. how often OCR produced a date-shaped fragment
 * that `findDate` missed and `findAmount` had to strip so the date's digits
 * couldn't become the amount (the "$3.00 from 03-08-2026" bug).
 *
 * Not a gate: real photos have no ground-truth labels yet, so there's nothing to
 * pass or fail — the point is the per-field confidence and guard-fire rate.
 *
 * Run: `npm run eval:ocr` — writes eval/reports/ocr-latest.json. Needs internet
 * on first run (tesseract downloads its engine + eng traineddata to the cache).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { createWorker } from "tesseract.js";
import { it } from "vitest";
import { loadConfig } from "../src/config";
import { createExtractionService, type ExtractionOutcome } from "../src/extraction/pipeline";
import { DATE_FRAGMENT_RE, findDate } from "../src/extraction/regex";
import { parseAmount } from "../src/extraction/validate";
import type { GatingLevel } from "../src/types";
import { IMAGE_EXTS, loadDevVars, REPORT_DIR } from "./lib";

type FieldSnapshot = { value: number | string | null; confidence: number };
/** Per-field confidence from the pipeline (§5.4 thresholds decide gating). */
type FieldMap = Record<
  "amount" | "date" | "vendor" | "abn" | "gst" | "invoice_number" | "due_date" | "gst_basis",
  FieldSnapshot
>;

interface OcrEvalEntry {
  id: string;
  gate: GatingLevel;
  source: ExtractionOutcome["source"];
  machineRead: boolean;
  fields: FieldMap;
  /** Date-shaped fragments present in the raw OCR text. */
  dateFragments: string[];
  /** True when findDate missed a date fragment and the amount guard stripped it. */
  guardFired: boolean;
  /** First bare number in the raw text — what the pre-fix picker could have logged. */
  naiveLeak: number | null;
  rawLines: string[];
}

function entryFields(extraction: ExtractionOutcome["extraction"]): FieldMap {
  const keys = ["amount", "date", "vendor", "abn", "gst", "invoice_number", "due_date"] as const;
  const out = {} as FieldMap;
  for (const key of keys) {
    const f = extraction[key];
    out[key] = { value: f.value, confidence: f.confidence };
  }
  out.gst_basis = { value: extraction.gst_basis, confidence: 1 };
  return out;
}

function naiveLeakOf(raw: string): number | null {
  const m = raw.match(/\b\d+(?:\.\d{1,2})?\b/);
  return m ? parseAmount(m[0]) : null;
}

it(
  "OCRs the bill images through the pipeline and reports per-field confidence + guard firings",
  async () => {
    loadDevVars();
    const config = loadConfig(env);
    const service = createExtractionService(config);

    // Which images: a single fresh photo (OCR_PHOTO) or the whole mirror.
    const explicit = env.OCR_PHOTO;
    const paths: Array<{ id: string; path: string; mime: string }> = [];
    if (explicit) {
      if (!existsSync(explicit)) throw new Error(`OCR_PHOTO not found: ${explicit}`);
      const ext = explicit.split(".").pop()?.toLowerCase() ?? "";
      const mime = IMAGE_EXTS.find((e) => e.ext === ext)?.mime ?? "image/jpeg";
      paths.push({ id: "photo", path: explicit, mime });
    } else {
      const dir = join(process.cwd(), "eval", "corpus", "images");
      if (!existsSync(dir)) throw new Error("eval/corpus/images/ does not exist — see eval/corpus/README.md");
      for (const file of readdirSync(dir).sort()) {
        const ext = file.split(".").pop()?.toLowerCase() ?? "";
        const mime = IMAGE_EXTS.find((e) => e.ext === ext)?.mime;
        // tesseract can't rasterize PDFs/HEIC here — only raster image mimes run.
        if (!mime || !mime.startsWith("image/")) continue;
        paths.push({ id: file.replace(/\.[^.]+$/, ""), path: join(dir, file), mime });
      }
    }
    if (paths.length === 0) {
      throw new Error("eval:ocr: no raster images in eval/corpus/images/ (and no OCR_PHOTO). See eval/corpus/README.md.");
    }

    const worker = await createWorker("eng");
    const entries: OcrEvalEntry[] = [];
    try {
      for (const img of paths) {
        const { data } = await worker.recognize(readFileSync(img.path));
        const raw = (data.text ?? "").trim();
        const outcome = await service.run({ ocrText: raw, gstRegistered: true });

        const fragments = raw.match(DATE_FRAGMENT_RE) ?? [];
        const foundByFindDate = findDate(raw) !== null;
        const guardFired = fragments.length > 0 && !foundByFindDate;

        entries.push({
          id: img.id,
          gate: outcome.gate,
          source: outcome.source,
          machineRead: outcome.machineRead,
          fields: entryFields(outcome.extraction),
          dateFragments: fragments,
          guardFired,
          naiveLeak: naiveLeakOf(raw),
          rawLines: raw.split(/\r?\n/).filter((l) => l.trim() !== ""),
        });
      }
    } finally {
      await worker.terminate();
    }

    const guardFirings = entries.filter((e) => e.guardFired).length;
    const report = {
      generatedAt: new Date().toISOString(),
      note: "OCR-path measurement — no ground truth, so no pass/fail; per-field confidence and date-leak guard firings only.",
      images: { total: paths.length, explicit: Boolean(explicit) },
      dateLeakGuard: {
        entriesWithFragments: entries.filter((e) => e.dateFragments.length > 0).length,
        guardFirings,
        guardFireRate: entries.length === 0 ? null : guardFirings / entries.length,
      },
      gating: entries.reduce<Record<string, number>>((acc, e) => {
        acc[e.gate] = (acc[e.gate] ?? 0) + 1;
        return acc;
      }, {}),
      entries,
    };

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, "ocr-latest.json"), JSON.stringify(report, null, 2) + "\n");

    // Console: per-entry fields + guard info, then the aggregate.
    console.log(`\n§5.7 OCR eval — ${entries.length} image(s)${explicit ? ` (OCR_PHOTO=${explicit})` : ""} OCR'd through the pipeline`);
    console.log(`Parsers: regex primary${config.geminiMock ? " + mock Workers AI (canned)" : " + Workers AI binding when available"}`);
    for (const e of entries) {
      const amount = e.fields.amount.value === null ? "—" : `$${e.fields.amount.value}@${(e.fields.amount.confidence * 100).toFixed(0)}%`;
      const date = e.fields.date.value === null ? "—" : `${e.fields.date.value}@${(e.fields.date.confidence * 100).toFixed(0)}%`;
      const vendor = e.fields.vendor.value === null ? "—" : `${e.fields.vendor.value}@${(e.fields.vendor.confidence * 100).toFixed(0)}%`;
      const gst = e.fields.gst.value === null ? "—" : `$${e.fields.gst.value}@${(e.fields.gst.confidence * 100).toFixed(0)}%`;
      const abn = e.fields.abn.value === null ? "—" : `${e.fields.abn.value}@${(e.fields.abn.confidence * 100).toFixed(0)}%`;
      const guard = e.guardFired
        ? ` ⚠️ GUARD FIRED (findDate missed ${e.dateFragments.join(" / ")}; naive leak would be $${e.naiveLeak})`
        : e.dateFragments.length > 0
          ? ` (date fragments ${e.dateFragments.join(" / ")} — findDate handled)`
          : "";
      console.log(
        `  ${e.id} [${e.gate}/${e.source}] amount ${amount} | date ${date} | vendor ${vendor} | gst ${gst} | abn ${abn}${guard}`,
      );
      if (e.guardFired) {
        console.log(`    raw lines: ${e.rawLines.join(" | ")}`);
      }
    }
    console.log(`\n  date-leak guard: fired ${guardFirings}/${entries.length} photo(s) (${(report.dateLeakGuard.guardFireRate ?? 0) * 100}%)`);
    console.log(`  gating: ${JSON.stringify(report.gating)}`);
    console.log(`Report: eval/reports/ocr-latest.json\n`);
  },
  120_000,
);
