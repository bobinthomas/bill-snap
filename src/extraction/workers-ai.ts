/**
 * Workers AI fallback parser — replaces the Google Gemini fetch entirely.
 *
 * Reads the raw OCR text of a bill and asks a Workers AI text model
 * (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for structured JSON matching
 * the §5.4 schema. The call goes through the Worker's native `env.AI` binding
 * — no external HTTP request, no API key, no base URL.
 *
 * This is a FALLBACK parser: the pipeline runs the regex parser first and only
 * consults this when regex cannot find the amount. Like every regex/OCR
 * reading, AI output is machine-read — it always lands on a confirm screen and
 * is never auto-logged (§5.4 level 3, §6.2 Variant C).
 *
 * The model is text-only — it cannot see the image, only the OCR text it is
 * given. `extractFromText` throws on any unparseable/absent response so the
 * pipeline treats a garbage reading exactly like a regex failure (manual
 * entry).
 */
import type { BillExtraction, ExtractedField } from "../types";

/** Structural type for the `env.AI` binding (Workers AI). */
export interface WorkersAi {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Text-based extractor used by the pipeline — OCR text in, schema out. */
export interface TextBillExtractor {
  extractFromText(text: string): Promise<BillExtraction>;
}

/** Vision-based extractor — image bytes in, schema out (§5.3). */
export interface ImageBillExtractor {
  extractFromImage(imageBytes: Uint8Array, mimeType?: string): Promise<BillExtraction>;
}

// Llama 3.3 70B (fp8, fast) — current catalog model, explicitly kept alive
// after the 2026-05-30 catalog refresh (llama-3.1-8b-instruct was deprecated).
// Text-only: reads the OCR text layer, never the image.
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// LLaVA 1.5 7B — current vision model (Beta). Reads image bytes directly via
// the env.AI binding, so the real WhatsApp photo path (which has no server-side
// OCR text) gets a real reading instead of falling through to manual entry.
// The image is passed as a binary string; the model is instructed to return the
// same §5.4 JSON schema as the text model.
export const DEFAULT_AI_VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const MAX_TOKENS = 256;
const TEMPERATURE = 0.1;

const SYSTEM_PROMPT = `You are a bookkeeping parser. Read the raw OCR text of an Australian bill, invoice, or receipt and return ONLY a JSON object with exactly these fields:
- "amount": the total the customer owes, as a number in AUD (null if not found)
- "vendor": the business or store name (null if not found)
- "date": the bill date as DD/MM/YYYY (null if not found)
- "abn": the Australian Business Number, with or without spaces (null if not found)
- "gst": the GST amount as a number (null if not mentioned)
- "gst_basis": "inclusive", "exclusive", or "none"
- "category": one of "wages", "utilities", "rent", "inventory", "misc"
- "invoice_number": the invoice number (null if not found)
- "due_date": as DD/MM/YYYY (null if not found)
- "confidence": "high", "medium", or "low" — how confident you are in the reading overall
Extract ONLY values that literally appear in the OCR text. A field is null unless you can point at the exact words in the text — never guess, infer, or invent an amount or date. If the text contains no currency amount, "amount" must be null; if it contains no date, "date" and "due_date" must be null. Respond with ONLY the JSON object, no commentary.`;

export function createWorkersAiExtractor(ai: WorkersAi, model = DEFAULT_AI_MODEL): TextBillExtractor {
  return {
    async extractFromText(text: string): Promise<BillExtraction> {
      const result = await ai.run(model, {
        prompt: `${SYSTEM_PROMPT}\n\nOCR TEXT:\n${text}`,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      });

      const parsed = parseJsonResponse(result);
      const extraction = toBillExtraction(parsed);
      // Anti-fabrication guard: instruct models still invent amounts/dates on
      // noisy OCR text (verified live). A field whose digits do not literally
      // appear in the OCR text is a hallucination, not a reading — null it so
      // the gate drops to Low and the user is asked for a manual entry instead
      // of being offered a made-up amount on the confirm screen.
      const digitsOf = (s: string) => s.replace(/\D/g, "");
      const textDigits = digitsOf(text);
      if (extraction.amount.value !== null && !textDigits.includes(digitsOf(String(extraction.amount.value)))) {
        extraction.amount = { value: null, confidence: 0 };
      }
      if (extraction.date.value !== null && !textDigits.includes(digitsOf(String(extraction.date.value)))) {
        extraction.date = { value: null, confidence: 0 };
      }
      return extraction;
    },
  };
}

const VISION_SYSTEM_PROMPT = `You are a bookkeeping parser. Look at this photo of a bill, invoice, or receipt and return ONLY a JSON object with exactly these fields:
- "amount": the total the customer owes, as a number in AUD (null if not visible)
- "vendor": the business or store name printed on the receipt (null if not visible)
- "date": the bill date as DD/MM/YYYY (null if not visible)
- "abn": the Australian Business Number, with or without spaces (null if not visible)
- "gst": the GST amount as a number (null if not mentioned)
- "gst_basis": "inclusive", "exclusive", or "none"
- "category": one of "wages", "utilities", "rent", "inventory", "misc"
- "invoice_number": the invoice number (null if not visible)
- "due_date": as DD/MM/YYYY (null if not visible)
- "confidence": "high", "medium", or "low" — how confident you are in the reading overall
Extract ONLY values you can actually read in the image. A field is null unless you can point at the exact printed text — never guess, infer, or invent an amount or date. If no currency amount is visible, "amount" must be null; if no date is visible, "date" and "due_date" must be null. Respond with ONLY the JSON object, no commentary.`;

export function createWorkersAiVisionExtractor(ai: WorkersAi, model = DEFAULT_AI_VISION_MODEL): ImageBillExtractor {
  return {
    async extractFromImage(imageBytes: Uint8Array): Promise<BillExtraction> {
      // LLaVA takes the image as an array of byte numbers (the Cloudflare-
      // documented input). A binary string would be re-encoded as UTF-8 on the
      // wire — mangling every byte ≥ 0x80 and making the tensor undecodable
      // (verified live: "failed to decode u8"). Numbers are byte-exact.
      const result = await ai.run(model, {
        image: Array.from(imageBytes),
        prompt: VISION_SYSTEM_PROMPT,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      });
      // No OCR text exists to check digits against, so the anti-fabrication
      // guard cannot run here — the machine-read confirm screen is the net.
      return toBillExtraction(parseJsonResponse(result));
    },
  };
}

/** Pull the text out of the model's response shape, then parse it as JSON —
 *  tolerating ``` fences, surrounding prose and trailing commas. Throws when
 *  nothing parseable comes back (garbage → same as a regex failure). */
function parseJsonResponse(result: unknown): unknown {
  const raw =
    (typeof result === "object" && result !== null
      ? (result as Record<string, unknown>).response ??
        (result as Record<string, unknown>).description ??
        (result as Record<string, unknown>).result ??
        (result as Record<string, unknown>).output_text
      : undefined) ?? result;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Workers AI returned no text");
  }
  const cleaned = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  // LLMs habitually leave trailing commas before } / ] — drop them so the
  // strict parser still lands. LLaVA also Markdown-escapes key underscores
  // (`gst\_basis`), which is invalid JSON — unescape those first.
  const tidy = cleaned
    .replace(/\\_/g, "_")
    .replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(tidy);
  } catch {
    // Strip anything outside the outermost {…} (models add prose/suffixes).
    const start = tidy.indexOf("{");
    const end = tidy.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(tidy.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error("Workers AI returned unparseable JSON");
  }
}

/** Map the overall high/medium/low confidence onto every present field. */
function confidenceOf(level: unknown): number {
  return level === "high" ? 0.95 : level === "medium" ? 0.7 : level === "low" ? 0.4 : 0;
}

function toBillExtraction(value: unknown): BillExtraction {
  const obj = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const level = confidenceOf(obj.confidence);
  const basis = obj.gst_basis;
  const category = obj.category;
  return {
    amount: field<number>(obj.amount, level),
    date: field<string>(obj.date, level), // DD/MM/YYYY; ISO normalisation is the validate layer's job
    vendor: field<string>(obj.vendor, level),
    abn: field<string>(obj.abn, level),
    gst: { value: null, confidence: 0 }, // recomputed by the validation layer
    gst_basis: basis === "inclusive" || basis === "exclusive" || basis === "none" ? basis : "none",
    invoice_number: field<string>(obj.invoice_number, level),
    due_date: field<string>(obj.due_date, level),
    category_hint: field<string>(category, level),
  };
}

function field<T>(value: unknown, confidence: number): ExtractedField<T> {
  const v = value === null || value === undefined || value === "" ? null : (value as T);
  return { value: v, confidence: v === null ? 0 : confidence };
}
