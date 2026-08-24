/**
 * Shared domain types (§5.4, §5.5, §5.6).
 */

/** Gating level for a bill image (§5.4). */
export type GatingLevel = "high" | "partial" | "low";

/** A single extracted field with the model's self-reported confidence (§5.4). */
export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
}

/** Parser response schema (§5.4) — regex, Workers AI and the dev mock all emit this. */
export interface BillExtraction {
  amount: ExtractedField<number>;
  date: ExtractedField<string>; // ISO YYYY-MM-DD
  vendor: ExtractedField<string>;
  /** The known vendor a mangled reading was canonicalised to (edit-distance
   *  match against KNOWN_VENDORS / learned vendors). Absent when the vendor was
   *  read verbatim (exact known match or unknown) — only regex sets it. */
  vendor_resolved_to?: ExtractedField<string>;
  abn: ExtractedField<string>;
  gst: ExtractedField<number>;
  gst_basis: "inclusive" | "exclusive" | "none";
  invoice_number: ExtractedField<string>;
  due_date: ExtractedField<string>;
  category_hint: ExtractedField<string>;
}

/** Draft flow states (§5.6). */
export type FlowState =
  | "processing"
  | "awaiting_confirm"
  | "editing_amount"
  | "editing_vendor"
  | "editing_date"
  | "editing_category"
  | "queued";

/** Normalised inbound WhatsApp event used by the router (§5.6). */
export interface InboundEvent {
  userPhone: string;
  waMessageId: string;
  waReceivedAt: Date;
  kind: "photo" | "text";
  /** For photo messages: WhatsApp media IDs at webhook time — the photo flow (M4/M8) downloads them and swaps in storage URLs. */
  imageUrls?: string[];
  text?: string;
  /** Local OCR text for a photo (browser OCR in the dev demo; §5.3 fallback) — parsed by regex as source "ocr". */
  ocrText?: string;
}
