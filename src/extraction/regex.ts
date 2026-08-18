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
  // NOTE: "telstra" is deliberately NOT here — it is a vendor name, not a
  // category: including it made the alias strip eat a real vendor (a Telstra
  // bill OCR'd cleanly lost its vendor to the leftover "Invoice No." line).
  { pattern: /\belectricity|power|water|gas|phone|internet|energy|utilities?\b/i, category: "utilities" },
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

export function extractFromText(text: string, knownVendors?: string[]): BillExtraction {
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
  const { category, vendor, vendorResolvedTo } = findCategoryAndVendor(
    dateStripped,
    amountValue,
    categoryOf(text),
    knownVendors,
  );

  return {
    amount: { value: amountValue, confidence: amountValue === null ? 0 : 1 },
    date: { value: dateValue, confidence: dateValue === null ? 0 : 1 },
    // A vendor canonicalised via edit-distance matching is less certain than
    // one read verbatim (exact known-name match or unknown) — confidence 0.9,
    // still above the §5.4 vendorHigh threshold so presence-gating is unchanged.
    vendor: {
      value: vendor,
      confidence: vendor === null ? 0 : vendorResolvedTo !== null ? 0.9 : 1,
    },
    // Log which known vendor a mangled reading resolved to — the dashboard
    // surfaces it so a canonicalised name is never mistaken for a verbatim read.
    vendor_resolved_to: {
      value: vendorResolvedTo,
      confidence: vendorResolvedTo === null ? 0 : 0.9,
    },
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
  // Amounts written out in words (Indian GST invoices often print only the
  // total in words when the numeric row OCRs badly: "FOUR THOUSAND FOUR
  // HUNDRED AND NINETY RUPEES ONLY" = ₹4,490). Gated on a currency word on
  // the line; the LARGEST wins, matching the total-line tie-break — the amount
  // owed is the biggest number on a bill, and a stray line-item words-amount
  // ("…AND NINETY PAISA ONLY") can't beat the grand total.
  const wordsAmount = findWordsAmount(dateSafe);
  if (wordsAmount !== null) return wordsAmount;
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
      // A bare digit inside a comparison ("Component < 1", "Qty > 2") is a
      // quantity/fragment, never the amount owed.
      if ((before !== undefined && /[<>]=?/.test(before)) || (after !== undefined && /[<>]=?/.test(after))) {
        continue;
      }
      // A single bare digit is almost never an amount: "1" from "Component < 1"
      // or a line-number "3" wins the document-order pass and becomes $1.00.
      // (Decimal bare numbers like "9.99" still match via the decimal branch.)
      if (!candidate.includes(".") && candidate.replace(/[,\d]/g, "").length === 0 && /^\d$/.test(candidate)) {
        continue;
      }
    }
    const n = parseAmount(candidate);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Known merchant names for vendor cleanup. OCR mangles a store name by one
 * character per word ("GUJARAT FRlGHT TOOLS" — lowercase L for I, "Te1stra"),
 * and a clean-looking mangled line would otherwise be kept verbatim as the
 * vendor. When the picked vendor is within edit distance 1 per word of a known
 * name (after OCR confusion normalisation), it is replaced by the canonical
 * spelling so the same merchant always logs the same vendor.
 *
 * This is the STATIC SEED — the corpus/demo merchants. `mergeKnownVendors`
 * grows it from the business's own logged bills at extraction time (the
 * webapp/demo deps gather vendors from `drafts.listLogged` and pass them in),
 * so the extraction layer itself stays stateless.
 */
export const KNOWN_VENDORS: string[] = [
  "Telstra",
  "Origin Energy",
  "Bunnings",
  "Caltex",
  "Homebase",
  "Rajesh",
  "Reliance Hypermart Limited",
  "HDFC Bank",
  "Gujarat Freight Tools",
];

/** A logged vendor is worth learning when it looks like a merchant name: not
 *  blank, short enough to be a name, and at least one real word with ≥ 3
 *  LETTERS — rejects OCR garbage walls ("%%% ###"), single-letter fragments
 *  ("x") and symbol-only tokens that would otherwise become canonicalisation
 *  targets. */
function isLearnableVendor(v: string): boolean {
  const trimmed = v.trim();
  const words = trimmed.split(/\s+/);
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 60 &&
    words.length >= 1 &&
    words.length <= 8 &&
    words.some((w) => (w.match(/[A-Za-z]/g) ?? []).length >= 3)
  );
}

/** Seed + vendors learned from the business's own logged bills, deduplicated by
 *  case-folded spelling. Learned entries keep their original casing; the seed
 *  keeps its canonical casing. Callers pass the result into `extractFromText`
 *  as `knownVendors`. */
export function mergeKnownVendors(learned: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...KNOWN_VENDORS, ...learned]) {
    if (v === null || !isLearnableVendor(v)) continue;
    const key = normalizeVendorCase(v);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Uppercase, collapse whitespace/punctuation to single spaces — no OCR
 *  folding, so an already-correct reading ("telstra" vs "Telstra") compares
 *  equal and is never rewritten. */
function normalizeVendorCase(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Uppercase, collapse whitespace/punctuation to single spaces, and fold the
 *  classic tesseract confusions (L→I, 0→O, 1→I, 5→S, 8→B) so "FRlGHT" and
 *  "FREIGHT" compare equal. Only used for the edit-distance pass — the
 *  already-exact check above uses normalizeVendorCase so a mangled "Te1stra"
 *  isn't mistaken for a clean "Telstra". */
function normalizeVendorForMatch(s: string): string {
  return normalizeVendorCase(s)
    .replace(/L/g, "I")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B");
}

/** Result of matching a candidate vendor against the known-vendor list. */
interface VendorMatch {
  /** The canonical spelling when the reading resolved to a known vendor, else the candidate itself. */
  value: string;
  /** The known vendor the reading was canonicalised TO — non-null exactly when
   *  an edit-distance match rewrote the candidate (vs an exact read). */
  resolvedTo: string | null;
}

/** Canonical spelling for a candidate vendor, or the candidate itself when no
 *  known vendor matches. Matching: same word count, each word within edit
 *  distance ≤ 1 of its counterpart (the levenshtein above), at least one word
 *  actually differs. An already-correct reading (same words ignoring case) is
 *  left untouched — "telstra" stays "telstra". A tie between two known vendors
 *  is treated as ambiguous (return the candidate unchanged) rather than guessing. */
function matchKnownVendor(candidate: string, knownVendors: string[] = KNOWN_VENDORS): VendorMatch {
  const candCase = normalizeVendorCase(candidate);
  if (candCase === "") return { value: candidate, resolvedTo: null };
  const cand = normalizeVendorForMatch(candidate);
  const candWords = cand.split(" ");
  let best: string | null = null;
  let bestScore = Infinity;
  let ambiguous = false;
  for (const known of knownVendors) {
    if (candCase === normalizeVendorCase(known)) continue; // already this merchant
    const knownWords = normalizeVendorForMatch(known).split(" ");
    if (knownWords.length !== candWords.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < candWords.length; i++) {
      if (candWords[i] === knownWords[i]) continue;
      const d = levenshtein(candWords[i]!, knownWords[i]!);
      if (d > 1) {
        ok = false;
        break;
      }
      score += d;
    }
    if (!ok) continue;
    if (score < bestScore) {
      bestScore = score;
      best = known;
      ambiguous = false;
    } else if (score === bestScore) {
      ambiguous = true;
    }
  }
  if (ambiguous || best === null) return { value: candidate, resolvedTo: null };
  return { value: best, resolvedTo: best };
}

/** English number words → value ("four thousand four hundred ninety" → 4490).
 *  Supports the Indian scale (lakh/crore) plus US/AU (million/billion); AND
 *  and ONLY are skippable fillers. Returns null on any unrecognised token so
 *  prose lines never half-parse. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  lakh: 100000, crore: 10000000, million: 1000000, billion: 1000000000,
};

/** Levenshtein distance — used to match OCR-mangled number words ("FOUS" for
 *  FOUR, "HUNDREO" for HUNDRED) against the dictionary. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Dictionary value for a token, tolerating OCR mangling: an exact match wins;
 *  otherwise any number word within edit distance 1 ("FOUS"→FOUR, "EIGHTY"
 *  intact) is accepted. Tokens shorter than 3 letters never fuzzy-match so a
 *  stray "to" can't become TWO. */
function numberWordValue(tok: string): number | undefined {
  const exact = NUMBER_WORDS[tok];
  if (exact !== undefined) return exact;
  if (tok.length < 3) return undefined;
  let best: number | undefined;
  let bestDist = Infinity;
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (Math.abs(word.length - tok.length) > 1) continue;
    const d = levenshtein(word, tok);
    if (d < bestDist) {
      bestDist = d;
      best = value;
    }
  }
  return bestDist <= 1 ? best : undefined;
}

function wordsToNumber(words: string): number | null {
  const tokens = words.toLowerCase().split(/[\s-]+/).filter((w) => w !== "" && w !== "and" && w !== "only");
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const tok of tokens) {
    const n = numberWordValue(tok);
    if (n === undefined) return null;
    if (n < 100) {
      current += n;
    } else if (n === 100) {
      current *= 100;
    } else {
      // thousand/lakh/crore/million… — multiply the run so far, bank it.
      current = (current || 1) * n;
      total += current;
      current = 0;
    }
  }
  return total + current;
}

/** Largest words-written amount across the text ("…RUPEES ONLY", "…DOLLARS"),
 *  with optional paisa/cent decimals ("AND NINETY PAISA" → .90). */
function findWordsAmount(text: string): number | null {
  let best: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    // Currency word must survive OCR — the whole point is lines like
    // "FOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY".
    const cur = line.match(/\b(RUPEES?|RUPEE|DOLLARS?|INR)\b/i);
    if (!cur || cur.index === undefined) continue;
    const before = line.slice(0, cur.index);
    const whole = wordsToNumber(before);
    if (whole === null) continue;
    // Optional paisa/cent fraction: "…AND NINETY PAISA" (₹) / "…AND FIFTY
    // CENTS" ($) after the currency word.
    const after = line.slice(cur.index + cur[0].length);
    const frac = after.match(/\b(?:AND\s+)?([A-Z]+)\s*(?:PAISA|CENTS?)\b/i);
    let value = whole;
    if (frac) {
      const cents = wordsToNumber(frac[1]!);
      if (cents !== null && cents < 100) value += cents / 100;
    }
    if (best === null || value > best) best = value;
  }
  return best;
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

/** True when the line is a words-written amount ("FOUR THOUSAND FOUR HUNDRED
 *  AND NINETY RUPEES ONLY") — the total printed in words on Indian GST
 *  invoices. Such a line must never be picked as the vendor; the amount pass
 *  already read it, and a clean OCR of it would otherwise win the vendor block
 *  when the numeric row mangled (the words line is letter-dense and all
 *  capitalised). */
function isWordsAmountLine(line: string): boolean {
  const cur = line.match(/\b(RUPEES?|RUPEE|DOLLARS?|INR)\b/i);
  if (!cur || cur.index === undefined) return false;
  return wordsToNumber(line.slice(0, cur.index)) !== null;
}

/** A line "looks like a store name" when it is letter-dense AND at least one
 *  surviving word is a real word (≥ 3 letters) — rejects symbol walls
 *  ("[5] Hore nan] %"), single-letter fragments ("wm N f") and blank lines. */
function isCleanVendorLine(rawLine: string, words: string[]): boolean {
  return (
    words.length > 0 &&
    letterRatio(rawLine) >= 0.7 &&
    words.some((w) => w.length >= 3) &&
    words.join(" ").length <= 60 &&
    !isWordsAmountLine(rawLine)
  );
}

function findCategoryAndVendor(
  text: string, // date-stripped
  amountValue: number | null,
  category: string | null,
  knownVendors?: string[],
): { category: string | null; vendor: string | null; vendorResolvedTo: string | null } {
  let remainder = text;
  // Words-written amount lines ("FOUR THOUSAND … RUPEES ONLY", possibly with
  // OCR-mangled number words like "EIGHTY-FOUS") are never the vendor — blank
  // them FIRST, before any stripping: the amount-token strip below removes the
  // Rs|INR currency word, and a blanked-before-strip line can't be turned into
  // a letter-dense "TWENTY FIVE THOUSAND ONLY" that would otherwise leak into
  // the vendor block whenever the numeric row OCR'd badly.
  remainder = remainder
    .split(/\r?\n/)
    .map((l) => (isWordsAmountLine(l) ? "" : l))
    .join("\n");
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
  const picked =
    block.length > 0 ? block.join(" ") : cleanWords(remainder).join(" ") || null;
  // Canonicalise a mangled merchant name against the known-vendor list (seed
  // + learned from logged bills: "GUJARAT FRlGHT TOOLS" → "Gujarat Freight
  // Tools") so the same store always logs the same vendor, and the §5.8
  // duplicate gate sees one spelling. `vendorResolvedTo` records the known
  // vendor the reading resolved to (non-null only for edit-distance matches).
  let vendor: string | null = null;
  let vendorResolvedTo: string | null = null;
  if (picked !== null) {
    const m = matchKnownVendor(picked, knownVendors);
    vendor = m.value;
    vendorResolvedTo = m.resolvedTo;
  }
  return { category, vendor, vendorResolvedTo };
}
