/**
 * Shared validation layer (§5.3): runs on both parsers before the confirm screen.
 * ABN checksum, GST recomputation, date normalisation to ISO, amount normalisation
 * to AUD decimal. GST is stored as null when the business is not GST-registered,
 * regardless of `gst_basis` (§5.4).
 */
import type { BillExtraction, ExtractedField } from "../types";

/** ABN checksum (ATO weighting factors, mod 89). */
export function validateAbn(abn: string): boolean {
  const digits = abn.replace(/\s+/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = (Number(digits[0]!) - 1) * weights[0]!;
  for (let i = 1; i < 11; i++) {
    sum += Number(digits[i]!) * weights[i]!;
  }
  return sum % 89 === 0;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Normalise to ISO `YYYY-MM-DD`. Accepts ISO, Australian `DD/MM/YYYY`,
 * `DD-MMM-YYYY`, `DD-MM-YYYY` / `DD.MM.YYYY`, spaced separators
 * (`09 / 05 / 2009`) and space-separated month names (`09 May 2009`,
 * `9 September 2009`) — the shapes OCR commonly produces — with two-digit
 * years (00-49 → 20xx, 50-99 → 19xx). Returns null for invalid or impossible
 * dates (e.g. 31/02).
 */
export function normaliseDate(value: string): string | null {
  const s = value.trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validYmd(m[1]!, m[2]!, m[3]!);

  // AU day-first order with /, - or . separators; stray spaces around the
  // separators are tolerated (OCR pads columns): "10/08/2026", "03-08-2026",
  // "3/8/26", "26.08.2026", "09 / 05 / 2009".
  m = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? twoDigitYear(m[3]!) : m[3]!;
    return validYmd(y, m[2]!, m[1]!);
  }

  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mm = MONTHS[m[2]!.toLowerCase()];
    if (mm) {
      const y = m[3]!.length === 2 ? twoDigitYear(m[3]!) : m[3]!;
      return validYmd(y, mm, m[1]!);
    }
  }

  // Space-separated month name — OCR often drops the dash between day and
  // month ("09 May 2009", "9 September 2009"). First three letters are
  // unique per English month, so full names slice cleanly.
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mm = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    if (mm) {
      const y = m[3]!.length === 2 ? twoDigitYear(m[3]!) : m[3]!;
      return validYmd(y, mm, m[1]!);
    }
  }

  return null;
}

/** 00-49 → 20xx, 50-99 → 19xx (bills are current or recent). */
function twoDigitYear(yy: string): string {
  return Number(yy) <= 49 ? `20${yy}` : `19${yy}`;
}

function validYmd(y: string, mo: string, d: string): string | null {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  // Zero-pad so the output is always strict ISO ("3/8/26" → "2026-08-03").
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Amount → AUD decimal, or null. Accepts `$4,850.00`, `AUD 4850`, `Rs 321.68`,
 *  `1,234.56`, `500`. */
export function parseAmount(text: string): number | null {
  const s = text
    .trim()
    .replace(/^(?:AUD|INR|Rs\.?|₹)\s*/i, "")
    .replace(/[$€]/g, "")
    .replace(/\s+/g, "");
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = m[1]!.replace(/,/g, "");
  const n = Number(whole + "." + (m[2] ?? ""));
  return Number.isFinite(n) ? round2(n) : null;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** GST per §5.3/§5.4: inclusive → amount/11, exclusive → amount × 0.10, none → null. */
export function computeGst(
  amount: number,
  basis: "inclusive" | "exclusive" | "none",
  gstRegistered: boolean,
): number | null {
  if (!gstRegistered) return null;
  if (basis === "inclusive") return round2(amount / 11);
  if (basis === "exclusive") return round2(amount * 0.1);
  return null;
}

/**
 * Apply the shared validation layer to a raw extraction (§5.3):
 * - amounts rounded, dates → ISO (invalid → null)
 * - GST recomputed from `gst_basis` — never taken verbatim
 * - ABN kept only if it passes the checksum (§5.4 "ABN not verified" otherwise)
 * - blank strings coerced to null
 */
export function normaliseExtraction(raw: BillExtraction, gstRegistered: boolean): BillExtraction {
  const amount = raw.amount.value === null ? null : round2(raw.amount.value);
  const gst = amount === null ? null : computeGst(amount, raw.gst_basis, gstRegistered);

  return {
    amount: field(raw.amount, amount),
    date: field(raw.date, raw.date.value === null ? null : normaliseDate(raw.date.value)),
    vendor: field(raw.vendor, blankToNull(raw.vendor.value)),
    ...(raw.vendor_resolved_to !== undefined
      ? { vendor_resolved_to: field(raw.vendor_resolved_to, blankToNull(raw.vendor_resolved_to.value)) }
      : {}),
    abn: field(
      raw.abn,
      raw.abn.value !== null && raw.abn.confidence >= 0.8 && validateAbn(raw.abn.value)
        ? raw.abn.value.replace(/\s+/g, " ")
        : null,
    ),
    gst: { value: gst, confidence: gst === null ? 0 : 1 },
    gst_basis: raw.gst_basis,
    invoice_number: field(raw.invoice_number, cleanInvoiceNumber(raw.invoice_number.value)),
    due_date: field(
      raw.due_date,
      raw.due_date.value === null ? null : normaliseDate(raw.due_date.value),
    ),
    category_hint: field(raw.category_hint, blankToNull(raw.category_hint.value)),
  };
}

function field<T>(original: ExtractedField<T>, value: T | null): ExtractedField<T> {
  return { value, confidence: value === null ? 0 : original.confidence };
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value.trim();
}

/** Drop fabricated invoice numbers: a run of ≥ 10 identical digits (e.g.
 *  LLaVA's "00000000000000000000") is an LLM hallucination, not an invoice. */
function cleanInvoiceNumber(value: string | null): string | null {
  const trimmed = blankToNull(value);
  if (trimmed === null) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 10 && new Set(digits).size === 1) return null;
  return trimmed;
}
