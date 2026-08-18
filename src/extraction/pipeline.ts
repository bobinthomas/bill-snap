/**
 * Extraction service (§5.3/§5.4): regex primary on OCR text → Workers AI
 * fallback when regex fails → shared validation → gating.
 *
 * Parser order (per the Workers AI architecture):
 * 1. OCR text, when present, is parsed by the deterministic regex parser first
 *    (the primary parser — §5.3).
 * 2. If regex cannot find the amount (the core extraction failure), the same
 *    OCR text goes to Workers AI (`env.AI`, no external API) as the fallback.
 * 3. If the OCR text itself is mostly garbage (`isGarbageOcrText` — a badly
 *    misread photo, not a genuine reading; verified live: a receipt's own
 *    bill/token reference number survived as the only clean digit run and
 *    won the regex fallback), neither step above can be trusted — the vision
 *    model gets a real look at the photo bytes instead, when they're in hand.
 * 4. If everything above fails (garbage/unparseable JSON — the extractor
 *    throws, or no image bytes exist), the regex result stands and the low
 *    gate routes the user to manual entry ("AMOUNT CATEGORY VENDOR").
 *
 * §5.8 trust posture: Workers AI readings (text + vision) are the trusted
 * parser — High-confidence AI readings auto-log with the 24-hour undo window,
 * the duplicate gate and the business's `auto_save` opt-out (§5.8, 4.1 step 5).
 * Regex, OCR and typed manual entries stay machine-read: they always land on a
 * confirm screen (§5.4 level 3, §6.2 Variant C).
 *
 * Photos WITHOUT OCR text (the real WhatsApp webhook path passes image bytes
 * only; there is no server-side OCR) go straight to the vision model
 * (`@cf/meta/llama-4-scout-17b-16e-instruct`) which reads the image bytes
 * directly. If that also fails, the photo produces source "none" →
 * manual-entry prompt.
 */
import type { AppConfig } from "../config";
import type { GatingLevel } from "../types";
import type { BillExtraction } from "../types";
import { classify } from "./gate";
import { createMockWorkersAiExtractor } from "./mock";
import { extractFromText, isGarbageOcrText } from "./regex";
import { normaliseExtraction } from "./validate";
import {
  createWorkersAiExtractor,
  createWorkersAiVisionExtractor,
  type ImageBillExtractor,
  type TextBillExtractor,
  type WorkersAi,
} from "./workers-ai";

export interface ExtractionInput {
  /** Image bytes (arrive with the storage download — M8). Read by the vision
   *  model when no OCR/typed text exists (the real WhatsApp photo path). */
  imageBytes?: Uint8Array;
  imageMimeType?: string;
  /** Text layer: manual entries, or OCR text when no image parser exists. */
  text?: string;
  /** Local OCR text read from the image (browser OCR in the dev demo) — regex first, Workers AI second. */
  ocrText?: string;
  /** From `businesses.gst_registered` (M7). Defaults to true. */
  gstRegistered?: boolean;
  /** Vendors known to the business (seed + learned from logged bills). Used to
   *  canonicalise mangled merchant names (§5.3 vendor cleanup). The extraction
   *  layer stays stateless — callers gather this from the store. */
  knownVendors?: string[];
}

export interface ExtractionOutcome {
  extraction: BillExtraction;
  gate: GatingLevel;
  /** True when the result must be confirmed, never auto-logged (§5.4/§5.8).
   *  False for Workers AI readings — the one trusted parser (§5.8). */
  machineRead: boolean;
  source: "ai" | "regex" | "ocr" | "none";
}

export interface ExtractionService {
  run(input: ExtractionInput): Promise<ExtractionOutcome>;
}

export function createExtractionService(config: AppConfig, ai?: WorkersAi): ExtractionService {
  // GEMINI_MOCK overrides the real binding (dev-only): the mock satisfies the
  // same TextBillExtractor interface, so source/machineRead/gating behave
  // identically. (The env flag keeps its historical name to avoid churn in
  // .dev.vars — it now gates the Workers AI mock, not Gemini.)
  const aiExtractor: TextBillExtractor | undefined = config.geminiMock
    ? createMockWorkersAiExtractor()
    : ai
      ? createWorkersAiExtractor(ai, config.aiModel)
      : undefined;
  const visionExtractor: ImageBillExtractor | undefined = config.geminiMock
    ? createMockWorkersAiExtractor()
    : ai
      ? createWorkersAiVisionExtractor(ai, config.aiVisionModel)
      : undefined;

  return {
    async run(input: ExtractionInput): Promise<ExtractionOutcome> {
      const gstRegistered = input.gstRegistered ?? true;

      let raw: BillExtraction;
      let source: ExtractionOutcome["source"];

      if (input.ocrText && input.ocrText.trim() !== "") {
        // Regex is the PRIMARY parser (§5.3) — deterministic and dependency-free.
        raw = extractFromText(input.ocrText, input.knownVendors);
        source = "ocr";
        // Workers AI is the FALLBACK: only when regex cannot find the amount.
        // A throw (binding failure, garbage/unparseable JSON) keeps the regex
        // result — the low gate then asks the user for a manual entry.
        if (raw.amount.value === null && aiExtractor) {
          try {
            raw = await aiExtractor.extractFromText(input.ocrText);
            source = "ai";
          } catch (err) {
            console.warn(`[extraction] Workers AI failed, keeping regex result: ${(err as Error).message}`);
          }
        }
        // The browser's local OCR can misread a photo so badly the text
        // itself is mostly noise — neither regex nor the text model above can
        // recover a real reading from text that never had one (verified
        // live: a receipt's own bill/token reference number survived as the
        // only clean digit run and won the regex fallback, through two
        // different Tesseract configs). When the photo bytes are in hand,
        // give the vision model a real look instead of trusting the guess.
        if (isGarbageOcrText(input.ocrText) && input.imageBytes && input.imageBytes.length > 0 && visionExtractor) {
          try {
            raw = await visionExtractor.extractFromImage(input.imageBytes, input.imageMimeType);
            source = "ai";
          } catch (err) {
            console.warn(`[extraction] Workers AI vision failed, keeping OCR/text result: ${(err as Error).message}`);
          }
        }
      } else if (input.text && input.text.trim() !== "") {
        // Typed manual entries are parsed by regex only — AI is for OCR text.
        raw = extractFromText(input.text, input.knownVendors);
        source = "regex";
      } else if (input.imageBytes && input.imageBytes.length > 0) {
        // Real WhatsApp photo path: no server-side OCR text, so the vision
        // model reads the image bytes directly (§5.3). A failure here (binding
        // down, unparseable JSON) leaves the reading empty → manual entry.
        if (visionExtractor) {
          try {
            raw = await visionExtractor.extractFromImage(input.imageBytes, input.imageMimeType);
            source = "ai";
          } catch (err) {
            console.warn(`[extraction] Workers AI vision failed, manual entry: ${(err as Error).message}`);
            raw = extractFromText("");
            source = "none";
          }
        } else {
          raw = extractFromText("");
          source = "none";
        }
      } else {
        raw = extractFromText("");
        source = "none";
      }

      const extraction = normaliseExtraction(raw, gstRegistered);
      const gate = classify(extraction, config.extraction);
      // §5.8 trust posture: Workers AI (text + vision) is the trusted parser
      // again — High-confidence AI readings auto-log (24 h undo, duplicate
      // gate, auto_save opt-out). Regex, OCR and typed entries stay
      // machine-read: they always land on a confirm screen (§6.2 Variant C).
      const machineRead: boolean = source !== "ai";

      return { extraction, gate, machineRead, source };
    },
  };
}
