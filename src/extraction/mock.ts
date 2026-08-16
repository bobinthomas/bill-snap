/**
 * DEV-ONLY mock Workers AI extractor (gated by GEMINI_MOCK=true — never set in
 * production). Returns realistic, high-confidence extractions from the OCR text
 * so the pipeline's Workers AI fallback paths (text on OCR text, vision on
 * photo bytes) can be demonstrated without a Workers AI binding or quota. It
 * implements the same `TextBillExtractor` + `ImageBillExtractor` interfaces
 * and is selected by the pipeline BEFORE the real binding, so
 * `source`/`machineRead` and the whole gating pipeline behave exactly as with
 * the real Workers AI call.
 *
 * Deterministic: an FNV-1a hash of the OCR text picks one bill from a small
 * realistic AU set — the same reading always yields the same bill (resending
 * it exercises the §5.8 duplicate gate), different readings yield different
 * bills.
 */
import type { BillExtraction, ExtractedField } from "../types";
import type { ImageBillExtractor, TextBillExtractor } from "./workers-ai";

interface MockBill {
  vendor: string;
  amount: number;
  date: string; // ISO YYYY-MM-DD
  abn: string | null;
  gstBasis: "inclusive" | "exclusive" | "none";
  invoiceNumber: string | null;
  dueDate: string | null;
  category: string;
}

const MOCK_BILLS: MockBill[] = [
  { vendor: "Telstra", amount: 99.95, date: "2026-08-14", abn: "51 824 753 556", gstBasis: "exclusive", invoiceNumber: "INV-99211", dueDate: "2026-08-28", category: "utilities" },
  { vendor: "Bunnings", amount: 214.9, date: "2026-08-11", abn: null, gstBasis: "inclusive", invoiceNumber: null, dueDate: null, category: "inventory" },
  { vendor: "Rajesh (wages)", amount: 500, date: "2026-08-12", abn: null, gstBasis: "none", invoiceNumber: null, dueDate: null, category: "wages" },
  { vendor: "Caltex", amount: 87.5, date: "2026-08-15", abn: null, gstBasis: "none", invoiceNumber: null, dueDate: null, category: "misc" },
  { vendor: "Origin Energy", amount: 245, date: "2026-08-10", abn: "51 824 753 556", gstBasis: "inclusive", invoiceNumber: "INV-2847", dueDate: "2026-08-30", category: "utilities" },
  { vendor: "Homebase", amount: 2200, date: "2026-08-05", abn: null, gstBasis: "none", invoiceNumber: null, dueDate: "2026-09-01", category: "rent" },
];

/** FNV-1a 32-bit — stable per byte content. */
export function hashBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createMockWorkersAiExtractor(): TextBillExtractor & ImageBillExtractor {
  const billFor = (bytes: Uint8Array) => MOCK_BILLS[hashBytes(bytes) % MOCK_BILLS.length]!;
  const toExtraction = (bill: MockBill): BillExtraction => ({
    amount: field(bill.amount, 0.99),
    date: field(bill.date, 0.97),
    vendor: field(bill.vendor, 0.97),
    abn: field<string>(bill.abn, bill.abn === null ? 0 : 0.95),
    gst: { value: null, confidence: 0 }, // recomputed by the validation layer
    gst_basis: bill.gstBasis,
    invoice_number: field<string>(bill.invoiceNumber, bill.invoiceNumber === null ? 0 : 0.95),
    due_date: field<string>(bill.dueDate, bill.dueDate === null ? 0 : 0.95),
    category_hint: field(bill.category, 0.95),
  });
  return {
    async extractFromText(text: string): Promise<BillExtraction> {
      return toExtraction(billFor(new TextEncoder().encode(text)));
    },
    async extractFromImage(imageBytes: Uint8Array): Promise<BillExtraction> {
      return toExtraction(billFor(imageBytes));
    },
  };
}

function field<T>(value: T | null, confidence: number): ExtractedField<T> {
  return { value, confidence };
}
