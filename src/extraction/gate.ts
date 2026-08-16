/**
 * §5.4 gating rule — every bill image is classified into exactly one level:
 *
 * - high:    `amount` high AND `date` high AND `vendor` non-null → auto-log (§5.8)
 * - partial: `amount` high but `date`/`vendor` missing/low, or `amount` in the
 *            low band → confirm screen with flags
 * - low:     `amount` absent or below the low threshold → regex fallback / manual entry
 */
import type { GatingLevel } from "../types";
import type { BillExtraction } from "../types";

export interface GateThresholds {
  amountHigh: number; // 0.90
  amountLow: number; // 0.70
  dateHigh: number; // 0.85
  vendorHigh: number; // 0.75 (informational — only presence gates)
}

export function classify(extraction: BillExtraction, t: GateThresholds): GatingLevel {
  const amountUsable = extraction.amount.value !== null && extraction.amount.confidence >= t.amountHigh;
  const amountInLowBand =
    extraction.amount.value !== null &&
    extraction.amount.confidence >= t.amountLow &&
    extraction.amount.confidence < t.amountHigh;
  const dateUsable = extraction.date.value !== null && extraction.date.confidence >= t.dateHigh;
  const vendorPresent = extraction.vendor.value !== null;

  if (amountUsable && dateUsable && vendorPresent) return "high";
  if (amountUsable && (!dateUsable || !vendorPresent)) return "partial";
  if (amountInLowBand) return "partial";
  return "low";
}
