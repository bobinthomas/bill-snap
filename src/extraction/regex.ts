/**
 * Fallback parser: regex + heuristics (§5.3). Deterministic, used for simple text
 * entries (`wages 500 rajesh`) and as the primary parser for OCR text. All output is
 * "machine-read" — it never auto-logs and always lands on a confirm screen
 * (§5.4 level 3 / §6.2 Variant C).
 */
import type { BillExtraction } from "../types";
import { parseAmount, validateAbn } from "./validate";

const CATEGORY_ALIASES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\bwages?\b/i, category: "wages" },
  { pattern: /\bsalary\b/i, category: "wages" },
  { pattern: /\brent\b/i, category: "rent" },
  { pattern: /\belectricity|power|water|gas|phone|internet|telstra|energy|utilities?\b/i, category: "utilities" },
  { pattern: /\binventory|stock|supplies|supplier|materials\b/i, category: "inventory" },
  { pattern: /\bmisc\b/i, category: "misc" },
];

/**
 * Rejoin words split across OCR line wraps ("Tele-" + "\n" + "stra" → "Telstra")
 * so a wrapped vendor/amount-word isn't left with a stray hyphen or split into
 * noise tokens. Guards keep real hyphenated names untouched:
 * - only a line-END hyphen directly abutting a word joins ("Rent-A-Car" on one
 *   line is never touched)
 * - the fragment must be a fresh word — not preceded by a letter/hyphen/quote,
 *   so a wrap inside a compound ("mother-in-" + "law") is skipped
 * - the fragment must end lowercase and the next line start lowercase, so
 *   all-caps OCR ("TELE-" + "STRA") and "Rent-A-" + "Car" are skipped
 */
function rejoinLineWraps(text: string): string {
  return text.replace(
    /(?<![A-Za-z'-])([A-Za-z]*[a-z])-[ \t]*\r?\n([a-z]{2,})/g,
    (_m, a: string, b: string) => a + b,
  );
}

export function extractFromText(text: string): BillExtraction {
  text = rejoinLineWraps(text);
  const dateValue = findDate(text);
  // Date-fragment guard (§5.7) — strip ALL date/time shapes for the amount AND
  // vendor passes, not just the first findDate match. A fragment findDate
  // missed ("03/08 2026", "12:30", a second date after a first one) would
  // otherwise survive into the vendor, or its digits could win the bare-number
  // amount pass — the guard closes both on typed text and OCR text alike.
  const dateStripped = text.replace(DATE_FRAGMENT_RE, " ");
  const amountValue = findAmount(dateStripped);
  const abnValue = findAbn(text);
  const gstBasis = detectGstBasis(text);
  // Vendor extraction runs on the date-fragment-stripped text so dates never become the vendor.
  const { category, vendor } = findCategoryAndVendor(dateStripped, amountValue, categoryOf(text));

  return {
    amount: { value: amountValue, confidence: amountValue === null ? 0 : 1 },
    date: { value: dateValue, confidence: dateValue === null ? 0 : 1 },
    vendor: { value: vendor, confidence: vendor === null ? 0 : 1 },
    abn: { value: abnValue, confidence: abnValue === null ? 0 : 1 },
    gst: { value: null, confidence: 0 }, // recomputed by the validation layer
    gst_basis: gstBasis,
    invoice_number: { value: null, confidence: 0 },
    due_date: { value: null, confidence: 0 },
    category_hint: { value: category, confidence: category === null ? 0 : 1 },
  };
}

/**
 * Amount labels that mark what the customer actually owes (vs a subtotal line).
 * Matched FUZZILY because OCR mangles these words — dot-matrix/thermal
 * receipts read "TOTAL" as "101AL", "T0TAL", "TOTA1"… Each keyword char
 * accepts the digits OCR confuses it with (T→1, O→0, A→4, L→1, E→8, S→5);
 * word boundaries keep "Subtotal" (preceded by a letter) and "TOTALS"
 * (followed by one) from matching. Bare "amount" is included — a card
 * receipt's AMOUNT line is the amount owed.
 */
const TOTAL_KEYWORDS = ["total", "amount", "balance", "due", "please pay", "you owe", "to pay", "amount payable"];
const OCR_CONFUSIONS: Record<string, string> = { t: "t1", o: "o0", a: "a4", l: "l1", e: "e8", s: "s5" };

function totalLikeWord(word: string): RegExp {
  const cls = word
    .toLowerCase()
    .split(/\s+/)
    .map((w) => [...w].map((c) => `[${OCR_CONFUSIONS[c] ?? c}]`).join(""))
    .join("\\s+");
  return new RegExp(`(?<![a-z0-9])${cls}(?![a-z0-9])`, "i");
}

function isTotalLike(line: string): boolean {
  return TOTAL_KEYWORDS.some((kw) => totalLikeWord(kw).test(line));
}

/**
 * Date/time shapes stripped before amount/vendor matching so a mangled date
 * can never become the amount (the §5.7 date-leak guard) or leak into the
 * vendor — applied on BOTH the OCR and typed-text paths in extractFromText.
 * Covers everything findDate can capture (ISO, DD/MM, DD-MM, DD.MM, dash
 * month-name like `10-Aug-2026`, space-month like `09 May 2009`, spaced
 * separators like `09 / 05 / 2009`) plus shapes findDate misses but amount
 * matching must not see (`03/08 2026`, clock times). Exported so the OCR eval
 * (eval/ocr.run.ts) measures guard firings against the SAME patterns.
 */
export const DATE_FRAGMENT_RE =
  /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b|\b\d{1,2}-[A-Za-z]{3}-\d{2,4}\b|\b\d{1,2}[\/\-]\d{1,2}\s+\d{2,4}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b|\b\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}\b/g;

function findAmount(text: string): number | null {
  // Date/time fragments mangled by OCR must never be read as amounts: a date
  // like "03-08-2026" or "3/8/26" that slipped past findDate would otherwise
  // yield "03" → $3.00 with no date captured. Strip date shapes and clock
  // times before matching; the bare pass below additionally skips fragments
  // glued to a date/time separator ("03/08 2026").
  const dateSafe = text.replace(DATE_FRAGMENT_RE, " ");
  // Currency markers: $/AUD (AU bills) plus Rs/INR/₹ so an overseas card
  // receipt (e.g. an HDFC/Reliance printout) still extracts its amount; bare
  // numbers stay a last-resort fallback for entries like "wages 500 rajesh".
  const AMOUNT_RE = new RegExp(
    CURRENCY_AMOUNT.source + "|\\b\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\b\\d+(?:\\.\\d{1,2})?\\b",
    "g",
  );
  const candidates = dateSafe.match(AMOUNT_RE) ?? [];
  // On multi-line OCR bills the first $ is usually the SUBTOTAL, not what the
  // customer owes — prefer a currency amount on a "total"-like line ("Total",
  // "Amount due", "Balance", "Please pay"). When several total-like lines carry
  // amounts (e.g. a stray "Total GST: $22.27" before the real total), the
  // LARGEST wins — the amount owed is the biggest number on a bill. Bare numbers
  // are skipped so an invoice number on the same line ("Total Invoice No. 2847")
  // can't win; "credit" lines are excluded ("Credit balance: $5,000" is never
  // what's owed); text with no $ at all falls through to the passes below.
  let totalAmount: number | null = null;
  const lines = dateSafe.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isTotalLike(line) || /credit/i.test(line)) continue;
    const onLine = currencyCandidates(line);
    // OCR often splits the label and the value across lines ("Total" then
    // "$267.27") — when the label line carries no amount, peek ONE content line
    // ahead (skipping blanks). The peek stops at the first non-empty line, so a
    // table header ("Item Total") can't reach down to a line item.
    const next = onLine.length === 0 ? nextContentLine(lines, i + 1) : "";
    const lookahead = next !== "" && !/credit/i.test(next) ? currencyCandidates(next) : [];
    for (const c of [...onLine, ...lookahead]) {
      const n = parseAmount(c);
      if (n !== null && (totalAmount === null || n > totalAmount)) totalAmount = n;
    }
  }
  if (totalAmount !== null) return totalAmount;
  // Prefer currency-prefixed candidates ("$245.00", "Rs 321.68") over bare
  // numbers so an invoice number ("Invoice No. 123") is not misread as the amount.
  const currency = candidates.find((c) => /^\$\s?|^AUD|^Rs\.?\s?|^INR\s?|^₹/i.test(c));
  if (currency !== undefined) {
    const n = parseAmount(currency);
    if (n !== null) return n;
  }
  for (const m of dateSafe.matchAll(AMOUNT_RE)) {
    const candidate = m[0];
    // Skip bare fragments glued to a date/time separator: "03" in "03/08 2026"
    // or "12" in "12:30". Currency-prefixed amounts are never date fragments.
    if (!/^\$\s?|^AUD|^Rs\.?\s?|^INR\s?|^₹/i.test(candidate)) {
      const before = dateSafe[m.index - 1];
      const after = dateSafe[m.index + candidate.length];
      if ((before !== undefined && /[\/\-:]/.test(before)) || (after !== undefined && /[\/\-:]/.test(after))) {
        continue;
      }
    }
    const n = parseAmount(candidate);
    if (n !== null) return n;
  }
  return null;
}

/** Currency-prefixed amount candidates on one line ($/AUD/Rs/INR/₹) — the total-line pass.
 *  `\s*` not `\s?`: OCR pads columns with variable whitespace ("AMOUNT    Rs            321.68"). */
const CURRENCY_AMOUNT =
  /\$\s*[\d,]+(?:\.\d{1,2})?|\bAUD\s*[\d,]+(?:\.\d{1,2})?|\b(?:Rs|INR)\.?\s*[\d,]+(?:\.\d{1,2})?|₹\s*[\d,]+(?:\.\d{1,2})?/gi;

function currencyCandidates(line: string): string[] {
  return line.match(CURRENCY_AMOUNT) ?? [];
}

/** First non-empty line at or after `start`; "" when none remains. */
function nextContentLine(lines: string[], start: number): string {
  for (let j = start; j < lines.length; j++) {
    if (lines[j]!.trim() !== "") return lines[j]!;
  }
  return "";
}

/** Exported for the §5.7 OCR eval: measures whether the date-leak guard had to
 *  catch fragments findDate missed (see eval/ocr.run.ts). */
export function findDate(text: string): string | null {
  // ISO, DD/MM/YYYY (or YY), DD-MMM-YYYY (or YY), DD-MM-YYYY (or YY), DD.MM.YYYY —
  // OCR commonly mangles the separators or truncates the year, so accept the
  // shapes and let the validation layer reject impossible dates.
  const m = text.match(
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}-[A-Za-z]{3}-\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/,
  );
  if (m) return m[0];
  // DATE-label fallback: when no standard shape matched anywhere, look for a
  // line whose DATE label survived OCR ("DATE :", "DATED") and try looser
  // shapes there — the digits/words often survive even when the rest of the
  // line is mangled ("DATE : 09 May 2009", "DATE : 09 / 05 / 2009").
  // Restricting the loose shapes to label lines keeps body text from
  // false-matching; the guard covers the same shapes either way.
  for (const line of text.split(/\r?\n/)) {
    if (!DATE_LABEL_RE.test(line)) continue;
    const fm = line.match(DATE_LABEL_SHAPES);
    if (fm) return fm[0];
  }
  return null;
}

/** Label that marks a date line ("DATE :", "DATED", "date"). */
const DATE_LABEL_RE = /\bdate(?:d)?\b/i;
/** Loose date shapes tried only on DATE-label lines: space-separated month
 *  names ("09 May 2009", "9 September 2009") and numeric separators with
 *  stray spaces around them ("09 / 05 / 2009", "09. 05. 2009"). */
const DATE_LABEL_SHAPES =
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b|\b\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}\b/;

function findAbn(text: string): string | null {
  const m = text.match(/\b\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/);
  if (!m) return null;
  return validateAbn(m[0]) ? m[0] : null;
}

function detectGstBasis(text: string): "inclusive" | "exclusive" | "none" {
  if (/gst\s*inclusive|\binc\s*gst|\bgst\s*inc\b/i.test(text)) return "inclusive";
  if (/\bgst\b|\btax\b/i.test(text)) return "exclusive";
  return "none";
}

function categoryOf(text: string): string | null {
  for (const alias of CATEGORY_ALIASES) {
    if (alias.pattern.test(text)) return alias.category;
  }
  return null;
}

/**
 * Heading/noise words that leak from OCR and typed entries ("internet bill",
 * "invoice no 123", "amount total", "ABN: 51 824 753 556"). The `(?!'s)` guard
 * keeps possessives like "Bill's Plumbing" intact.
 */
const NOISE =
  /\b(?:gst|inc|incl|inclusive|exclusive|tax|bill|invoice|inv|receipt|total|amount|subtotal|balance|due|date|account|page|number|no|abn|acn|phone|email|pay|paid|payment|thank|please|business|customer|address|pty|ltd|you|for|your)(?!'s)\b/i;

/** Strip leading/trailing punctuation artifacts ("-", "\u2022", "1.", "Amount:", "$245.00") from a token. */
function cleanToken(w: string): string {
  return w
    .replace(/^[\-$\u20ac\u2013\u2014\u2022|_*:;.,()\[\]'"\u201c\u201d#]+/, "")
    .replace(/[\-$\u20ac\u2013\u2014\u2022|_*:;.,()\[\]'"\u201c\u201d#]+$/, "");
}

/** Tokens of a cleaned line that could belong to a vendor: strip punctuation
 *  artifacts, heading/noise words ("bill", "invoice", "total", "abn"…) and
 *  leftover amounts/ABN chunks ("51", "1,234.56"). */
function cleanWords(line: string): string[] {
  return line
    .split(/\s+/)
    .map(cleanToken)
    .filter(
      (w) =>
        w.length > 0 &&
        !NOISE.test(w) &&
        !/^[\d,]+(?:\.\d{1,2})?$/.test(w), // leftover amounts, ABN chunks, years
    );
}

/** Letter density of a line. Real store-name lines are almost all letters;
 *  OCR garbage walls carry brackets, digits, colons, ©, %, quotes… */
function letterRatio(line: string): number {
  const compact = line.replace(/\s+/g, "");
  if (compact.length === 0) return 0;
  return compact.replace(/[^A-Za-z]/g, "").length / compact.length;
}

/** A line "looks like a store name" when it is letter-dense AND at least one
 *  surviving word is a real word (≥ 3 letters) — rejects symbol walls
 *  ("[5] Hore nan] %"), single-letter fragments ("wm N f") and blank lines. */
function isCleanVendorLine(rawLine: string, words: string[]): boolean {
  return (
    words.length > 0 &&
    letterRatio(rawLine) >= 0.7 &&
    words.some((w) => w.length >= 3) &&
    words.join(" ").length <= 60
  );
}

function findCategoryAndVendor(
  text: string, // date-stripped
  amountValue: number | null,
  category: string | null,
): { category: string | null; vendor: string | null } {
  let remainder = text;
  if (amountValue !== null) {
    // Remove the matched amount token(s) — try the exact formatted number first,
    // then a currency-prefixed variant.
    remainder = remainder
      .replace(new RegExp(`\\$?\\s?${amountValue.toFixed(2).replace(".", "\\.")}`, "i"), " ")
      .replace(new RegExp(`\\$?\\s?${amountValue}`, "i"), " ")
      .replace(/AUD\s*/i, " ")
      .replace(/\b(?:Rs|INR)\.?\s*/i, " ");
  }
  if (category !== null) {
    const alias = CATEGORY_ALIASES.find((a) => a.category === category);
    if (alias) {
      // Remove the first category-alias match (the label: "utilities", "internet",
      // "wages") so it doesn't become the vendor — but keep it when stripping
      // leaves only noise or nothing: alias words double as vendor names, so
      // "Telstra GST INCLUSIVE" must keep "telstra" (stripping it leaves an
      // all-noise remainder, which would otherwise lose the vendor entirely).
      const stripped = remainder.replace(alias.pattern, " ");
      const leftover = cleanWords(stripped);
      if (leftover.length > 0) remainder = stripped;
    }
  }
  // Vendor = the FIRST run of clean-looking lines, not every surviving token:
  // joining everything across a noisy thermal receipt produced a garbage wall
  // ("Hore nan % ed } HET LN IE …"). Walk the lines top-to-bottom; once the
  // first clean-looking line appears, keep extending through the following
  // clean lines (a receipt's merchant block is usually several lines: "HDFC
  // BANK" + "RELIANCE HYPERMART LIMITED" + "MADURAI IN") and stop at the first
  // non-clean line. Lines whose words are empty (dates, amounts, headings)
  // never start or extend the block; if NO line qualifies, fall back to joining
  // every surviving token exactly as before (typed one-liners, boilerplate).
  const lines = text.split(/\r?\n/);
  const remainderLines = remainder.split(/\r?\n/);
  const block: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const words = cleanWords(remainderLines[i] ?? "");
    if (!isCleanVendorLine(lines[i] ?? "", words)) {
      if (block.length > 0) break; // first non-clean line ends the merchant block
      continue; // keep scanning for the first clean-looking line
    }
    const joined = block.join(" ");
    if (joined.length > 0 && joined.length + words.join(" ").length + 1 > 60) break;
    block.push(...words);
  }
  const vendor =
    block.length > 0 ? block.join(" ") : cleanWords(remainder).join(" ") || null;
  return { category, vendor };
}
