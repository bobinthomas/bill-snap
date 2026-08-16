/**
 * Shared §5.7 eval machinery — used by `harness.run.ts` (baseline) and
 * `sweep.run.ts` (threshold operating-point search).
 *
 * Scoring follows §5.7 exactly:
 * - success = a High/Partial gate with the correct amount and date;
 * - field accuracy is measured where the field is expected AND the extraction
 *   returned it with High confidence (≥ the §5.4 field threshold), so the
 *   accuracy pool itself depends on the thresholds under test;
 * - GST is correct within 1 cent.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { isDuplicateMatch, toDuplicateCandidate, type DuplicateCandidate } from "../src/db/drafts";
import type { ExtractionOutcome } from "../src/extraction/pipeline";
import type { BillExtraction, GatingLevel } from "../src/types";

export const CORPUS_DIR = join(process.cwd(), "eval", "corpus");
export const LABELS_DIR = join(CORPUS_DIR, "labels");
export const IMAGES_DIR = join(CORPUS_DIR, "images");
export const SYNTHETIC_DIR = join(CORPUS_DIR, "synthetic");
export const REPORT_DIR = join(process.cwd(), "eval", "reports");

/**
 * Merge `.dev.vars` into process.env (existing env wins) so `npm run eval` /
 * `npm run sweep` pick up env exactly like wrangler dev does — the harness
 * otherwise sees an empty env and silently runs regex only.
 */
export function loadDevVars(): void {
  const path = join(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
export const IMAGE_EXTS: Array<{ ext: string; mime: string }> = [
  { ext: "jpg", mime: "image/jpeg" },
  { ext: "jpeg", mime: "image/jpeg" },
  { ext: "png", mime: "image/png" },
  { ext: "webp", mime: "image/webp" },
  { ext: "heic", mime: "image/heic" },
  { ext: "pdf", mime: "application/pdf" },
];

/** §5.7 pass criteria (MVP targets; env-overridable so Month-3 goals can be gated). */
export const TARGETS = {
  successRate: num(env.EVAL_SUCCESS_TARGET, 0.7),
  amount: num(env.EVAL_AMOUNT_TARGET, 0.95),
  date: num(env.EVAL_DATE_TARGET, 0.9),
  vendor: num(env.EVAL_VENDOR_TARGET, 0.8),
};

export interface CorpusEntry {
  id: string;
  kind: "image" | "text";
  text?: string;
  /** OCR text read from the image — replays the local-OCR path (source "ocr"). */
  ocr_text?: string;
  source?: string;
  should_log: boolean;
  expected: Record<string, unknown>;
  /** Photo orientation — §5.7's portrait vs landscape hard-case dimension. */
  orientation?: "portrait" | "landscape";
  /** Hard cases (crumpled/dark/angled/handwritten/non-bill) — the §5.7 quick-iteration subset. */
  hard?: boolean;
  /** Near-duplicate partner id — anchors the §5.8 duplicate-gate check (both sides may set it). */
  duplicate_of?: string;
}

export interface ScoredEntry {
  id: string;
  mode: "image" | "text-regex" | "text-ocr";
  gate: GatingLevel;
  source: ExtractionOutcome["source"];
  success: boolean;
  notAutoLogged: boolean | null;
  fieldChecks: Record<string, boolean | null>;
  actual: Record<string, unknown>;
  extraction: BillExtraction;
  hard: boolean;
  orientation?: "portrait" | "landscape";
  reasons: string[];
}

export function loadLabels(): CorpusEntry[] {
  const files = readdirSync(LABELS_DIR).filter((f) => f.endsWith(".json")).sort();
  return files.map((file) => {
    const raw = JSON.parse(readFileSync(join(LABELS_DIR, file), "utf8")) as Partial<CorpusEntry>;
    if (typeof raw.id !== "string" || raw.id === "") throw new Error(`label ${file}: missing id`);
    if (typeof raw.should_log !== "boolean") throw new Error(`label ${raw.id}: missing should_log`);
    const orientation = raw.orientation === undefined ? undefined : raw.orientation;
    if (orientation !== undefined && orientation !== "portrait" && orientation !== "landscape") {
      throw new Error(`label ${raw.id}: orientation must be portrait|landscape`);
    }
    return {
      id: raw.id,
      kind: raw.kind === "text" ? "text" : "image",
      text: raw.text,
      ocr_text: raw.ocr_text,
      source: raw.source,
      should_log: raw.should_log,
      expected: raw.expected ?? {},
      orientation,
      hard: raw.hard === true,
      duplicate_of: typeof raw.duplicate_of === "string" ? raw.duplicate_of : undefined,
    };
  });
}

/** Locate an image for a label: the private mirror first, then the committed
 *  `synthetic/` renders (so CI can score the image path without the mirror). */
export function findImage(id: string): { bytes: Uint8Array; mime: string } | null {
  for (const dir of [IMAGES_DIR, SYNTHETIC_DIR]) {
    for (const { ext, mime } of IMAGE_EXTS) {
      const path = join(dir, `${id}.${ext}`);
      if (existsSync(path)) return { bytes: readFileSync(path), mime };
    }
  }
  return null;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

type FieldKind = "amount" | "date" | "vendor" | "gst" | "abn" | "invoice" | "basis";

/** Correct / incorrect / not-applicable (label has no expected value). */
export function checkField(expected: unknown, actual: number | string | null, kind: FieldKind): boolean | null {
  if (expected === undefined || expected === null) return null;
  if (actual === null) return false;
  switch (kind) {
    case "amount":
      return typeof expected === "number" && typeof actual === "number" && Math.abs(actual - expected) <= 0.005;
    case "gst":
      return typeof expected === "number" && typeof actual === "number" && Math.abs(actual - expected) <= 0.01;
    case "date":
    case "invoice":
      return String(actual) === String(expected);
    case "vendor": {
      const a = normalize(String(actual));
      const e = normalize(String(expected));
      return a === e || (a !== "" && e !== "" && (a.includes(e) || e.includes(a)));
    }
    case "abn":
      return normalize(String(actual)).replace(/\s+/g, "") === String(expected).replace(/\s+/g, "");
    case "basis":
      return String(actual) === String(expected);
  }
}

export function scoreEntry(entry: CorpusEntry, outcome: ExtractionOutcome): ScoredEntry {
  const e = outcome.extraction;
  const exp = entry.expected;

  const amount = checkField(exp.amount, e.amount.value, "amount");
  const date = checkField(exp.date, e.date.value, "date");
  const vendor = checkField(exp.vendor, e.vendor.value, "vendor");
  const gst = checkField(exp.gst, e.gst.value, "gst");
  const basis = checkField(exp.gst_basis, e.gst_basis, "basis");
  const abn = checkField(exp.abn, e.abn.value, "abn");
  const invoice = checkField(exp.invoice_number, e.invoice_number.value, "invoice");

  // §5.7 success: a High/Partial confirm screen with the correct amount and date.
  const success = outcome.gate !== "low" && amount !== false && date !== false;
  const notAutoLogged = entry.should_log ? null : outcome.gate !== "high";

  const reasons: string[] = [];
  if (outcome.gate === "low") reasons.push(`gated low (${outcome.source})`);
  for (const [label, ok] of [
    ["amount", amount],
    ["date", date],
    ["vendor", vendor],
    ["gst", gst],
    ["gst_basis", basis],
    ["abn", abn],
    ["invoice_number", invoice],
  ] as const) {
    if (ok === false) {
      const actual = (e as unknown as Record<string, { value: unknown }>)[label]?.value ?? "null";
      reasons.push(`${label} incorrect (expected ${String(exp[label] ?? "—")}, got ${String(actual)})`);
    }
  }

  return {
    id: entry.id,
    mode: entry.kind === "text" ? (entry.ocr_text !== undefined ? "text-ocr" : "text-regex") : "image",
    gate: outcome.gate,
    source: outcome.source,
    success,
    notAutoLogged,
    fieldChecks: { amount, date, vendor, gst, gst_basis: basis, abn, invoice_number: invoice },
    actual: {
      amount: e.amount.value,
      date: e.date.value,
      vendor: e.vendor.value,
      gst: e.gst.value,
      gst_basis: e.gst_basis,
      abn: e.abn.value,
      invoice_number: e.invoice_number.value,
    },
    extraction: e,
    hard: entry.hard === true,
    orientation: entry.orientation,
    reasons,
  };
}

export interface FieldMetric {
  n: number;
  correct: number;
  accuracy: number | null;
}

/** §5.7 field accuracy: correct share where the field is expected AND returned High confidence. */
export function fieldAccuracy(items: ScoredEntry[], field: string, highThreshold: number): FieldMetric {
  const confidenceOf = (s: ScoredEntry): number => {
    const f = (s.extraction as unknown as Record<string, { confidence: number }>)[field];
    return f === undefined ? 0 : f.confidence;
  };
  const eligible = items.filter((s) => s.fieldChecks[field] !== null && confidenceOf(s) >= highThreshold);
  const correct = eligible.filter((s) => s.fieldChecks[field] === true).length;
  return { n: eligible.length, correct, accuracy: eligible.length === 0 ? null : correct / eligible.length };
}

export interface Aggregate {
  bills: ScoredEntry[];
  nonBills: ScoredEntry[];
  successRate: number | null;
  /** §5.7 quick-iteration subset: success over the deliberately hard cases only. */
  hardCase: { n: number; successRate: number | null };
  field: { amount: FieldMetric; date: FieldMetric; vendor: FieldMetric };
  gst: { n: number; correct: number };
  gating: Record<GatingLevel, number>;
  failures: ScoredEntry[];
}

/** Aggregate scored entries under one set of §5.4 high thresholds. */
export function aggregate(scored: ScoredEntry[], high: { amount: number; date: number; vendor: number }): Aggregate {
  const bills = scored.filter((s) => s.notAutoLogged === null);
  const nonBills = scored.filter((s) => s.notAutoLogged !== null);
  const successRate = bills.length === 0 ? null : bills.filter((s) => s.success).length / bills.length;

  const field = {
    amount: fieldAccuracy(bills, "amount", high.amount),
    date: fieldAccuracy(bills, "date", high.date),
    vendor: fieldAccuracy(bills, "vendor", high.vendor),
  };
  const gstN = scored.filter((s) => s.fieldChecks.gst !== null).length;
  const gstCorrect = scored.filter((s) => s.fieldChecks.gst === true).length;
  const gating: Record<GatingLevel, number> = { high: 0, partial: 0, low: 0 };
  for (const s of scored) gating[s.gate] = (gating[s.gate] ?? 0) + 1;

  const hardBills = bills.filter((s) => s.hard);
  const hardCase = {
    n: hardBills.length,
    successRate: hardBills.length === 0 ? null : hardBills.filter((s) => s.success).length / hardBills.length,
  };

  return {
    bills,
    nonBills,
    successRate,
    hardCase,
    field,
    gst: { n: gstN, correct: gstCorrect },
    gating,
    failures: scored.filter((s) => !s.success || s.reasons.length > 0),
  };
}

export interface CriteriaResult {
  target: number;
  value: number | null;
  pass: boolean;
}

/**
 * §5.8 duplicate-gate check over the near-duplicate pairs (`duplicate_of`).
 * Two separately-logged bills must never match the gate: a false match would
 * suppress the second bill's auto-log. Checked twice — once on the ground-truth
 * labels (guards against sloppy corpus authoring), once on the pipeline's
 * extractions (catches the parser hallucinating identical vendor+amount or
 * invoice on distinct bills).
 */
export interface DuplicateCheckResult {
  pairs: number;
  /** Pair keys whose LABEL values would false-match the gate. */
  labelMatches: string[];
  /** Pair keys whose PIPELINE EXTRACTIONS would false-match the gate. */
  extractionMatches: string[];
  /** Pairs where both members were scored (extraction check is meaningful). */
  checked: number;
}

export function checkDuplicatePairs(
  labels: CorpusEntry[],
  scoredByLabel: Map<string, ScoredEntry>,
): DuplicateCheckResult {
  const pairs = new Map<string, [CorpusEntry, CorpusEntry]>();
  for (const label of labels) {
    const otherId = label.duplicate_of;
    if (!otherId) continue;
    const other = labels.find((l) => l.id === otherId);
    if (!other) throw new Error(`label ${label.id}: duplicate_of points at unknown label ${otherId}`);
    const key = [label.id, otherId].sort().join("|");
    if (!pairs.has(key)) pairs.set(key, [label, other]);
  }

  const labelMatches: string[] = [];
  const extractionMatches: string[] = [];
  let checked = 0;

  for (const [a, b] of pairs.values()) {
    const aLabel = expectedToCandidate(a.expected);
    const bLabel = expectedToCandidate(b.expected);
    if (isDuplicateMatch(aLabel, bLabel) || isDuplicateMatch(bLabel, aLabel)) {
      labelMatches.push(`${a.id}~${b.id}`);
    }

    const sa = scoredByLabel.get(a.id);
    const sb = scoredByLabel.get(b.id);
    if (sa && sb) {
      checked++;
      const aExt = toDuplicateCandidate(sa.extraction);
      const bExt = toDuplicateCandidate(sb.extraction);
      if (isDuplicateMatch(aExt, bExt) || isDuplicateMatch(bExt, aExt)) {
        extractionMatches.push(`${a.id}~${b.id}`);
      }
    }
  }

  return { pairs: pairs.size, labelMatches, extractionMatches, checked };
}

function expectedToCandidate(expected: Record<string, unknown>): DuplicateCandidate {
  return {
    invoiceNumber: typeof expected.invoice_number === "string" ? expected.invoice_number : null,
    vendor: typeof expected.vendor === "string" ? expected.vendor : null,
    amount: typeof expected.amount === "number" ? expected.amount : null,
  };
}

/** §5.7 criteria vs targets; criteria with no labelled data are n/a (pass). */
export function computeCriteria(agg: Aggregate): Record<string, CriteriaResult> {
  return {
    successRate: {
      target: TARGETS.successRate,
      value: agg.successRate,
      pass: agg.successRate !== null && agg.successRate >= TARGETS.successRate,
    },
    amount: {
      target: TARGETS.amount,
      value: agg.field.amount.accuracy,
      pass: agg.field.amount.accuracy !== null && agg.field.amount.accuracy >= TARGETS.amount,
    },
    date: {
      target: TARGETS.date,
      value: agg.field.date.accuracy,
      pass: agg.field.date.accuracy !== null && agg.field.date.accuracy >= TARGETS.date,
    },
    vendor: {
      target: TARGETS.vendor,
      value: agg.field.vendor.accuracy,
      pass: agg.field.vendor.accuracy !== null && agg.field.vendor.accuracy >= TARGETS.vendor,
    },
    gst: {
      target: 1.0,
      value: agg.gst.n === 0 ? null : agg.gst.correct / agg.gst.n,
      pass: agg.gst.n > 0 && agg.gst.correct === agg.gst.n,
    },
  };
}

export function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
