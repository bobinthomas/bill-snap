/**
 * Vendor -> category memory (episodic + semantic + procedural layers, see
 * the vendor-category-memory plan).
 *
 * - Episodic: `aggregateVendorCategoryHistory` turns a business's own past
 *   confirmed transactions into a per-vendor majority category — the
 *   business's own experience with that vendor.
 * - Semantic: `SEMANTIC_VENDOR_CATEGORIES` is a small static cold-start
 *   dictionary for well-known vendor names, used before any history exists.
 * - Procedural: `fillCategoryHint` is the merge rule the pipeline calls to
 *   turn either signal into a pre-filled confirm-screen suggestion, without
 *   ever overriding a category this bill's own text/model read already found.
 *
 * Kept D1-free and pure so every piece here is unit-testable without a
 * database, mirroring how `mergeKnownVendors` (regex.ts) keeps the
 * extraction layer stateless — history is always injected, never queried
 * from inside this module or pipeline.ts.
 */
import type { BillExtraction } from "../types";
import { normalizeVendorCase } from "./regex";

export const CATEGORIES = ["wages", "utilities", "rent", "inventory", "misc"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface VendorCategorySuggestion {
  category: Category;
  confidence: number;
  sampleSize: number;
}

/** A vendor needs at least this many confirmed instances before its history
 *  is trusted — one occurrence is a coincidence, not a pattern. */
const MIN_SAMPLE_SIZE = 2;
/** ...and the majority category must hold at least this share of them. */
const MIN_MAJORITY_SHARE = 0.7;

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Groups (vendor, category) rows by normalised vendor name and keeps the
 * majority category per vendor, only when it clears both the sample-size and
 * majority-share bars. Vendors that don't clear the bar are omitted — callers
 * fall through to the semantic dictionary (or "misc") for those.
 */
export function aggregateVendorCategoryHistory(
  rows: Array<{ vendor: string; category: string }>,
): Map<string, VendorCategorySuggestion> {
  const counts = new Map<string, Map<Category, number>>();
  for (const row of rows) {
    if (!isCategory(row.category)) continue;
    const key = normalizeVendorCase(row.vendor);
    if (key === "") continue;
    const byCategory = counts.get(key) ?? new Map<Category, number>();
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    counts.set(key, byCategory);
  }

  const result = new Map<string, VendorCategorySuggestion>();
  for (const [vendorKey, byCategory] of counts) {
    let total = 0;
    let topCategory: Category | null = null;
    let topCount = 0;
    for (const [category, count] of byCategory) {
      total += count;
      if (count > topCount) {
        topCount = count;
        topCategory = category;
      }
    }
    if (topCategory === null || total < MIN_SAMPLE_SIZE) continue;
    const confidence = topCount / total;
    if (confidence < MIN_MAJORITY_SHARE) continue;
    result.set(vendorKey, { category: topCategory, confidence, sampleSize: total });
  }
  return result;
}

/**
 * Cold-start dictionary: well-known vendor names -> category, for businesses
 * with no history of their own yet. Deliberately separate from
 * CATEGORY_ALIASES (regex.ts) — that table matches keywords found *in bill
 * text*; this one matches vendor *names* (regex.ts:14-16 explains why the two
 * must stay distinct — a vendor name in the keyword table ate a real vendor).
 * Keyed by normalizeVendorCase() output.
 */
export const SEMANTIC_VENDOR_CATEGORIES: Record<string, Category> = {
  [normalizeVendorCase("Telstra")]: "utilities",
  [normalizeVendorCase("Origin Energy")]: "utilities",
  [normalizeVendorCase("AGL")]: "utilities",
  [normalizeVendorCase("Optus")]: "utilities",
  [normalizeVendorCase("Bunnings")]: "inventory",
  [normalizeVendorCase("Gujarat Freight Tools")]: "inventory",
  [normalizeVendorCase("Reliance Hypermart Limited")]: "inventory",
  [normalizeVendorCase("Caltex")]: "utilities",
};

/**
 * The procedural merge rule: never override a category this bill's own
 * extraction already found (regex keyword match or AI read outranks any
 * historical guess), otherwise prefer this business's own episodic history,
 * otherwise fall back to the semantic dictionary. Returns `extraction`
 * unchanged when neither source has anything for this vendor.
 */
export function fillCategoryHint(
  extraction: BillExtraction,
  history: Map<string, VendorCategorySuggestion>,
): BillExtraction {
  if (extraction.category_hint.value !== null) return extraction;
  const vendor = extraction.vendor.value;
  if (vendor === null) return extraction;

  const key = normalizeVendorCase(vendor);
  const episodic = history.get(key);
  if (episodic) {
    return {
      ...extraction,
      category_hint: { value: episodic.category, confidence: episodic.confidence },
    };
  }

  const semantic = SEMANTIC_VENDOR_CATEGORIES[key];
  if (semantic) {
    return { ...extraction, category_hint: { value: semantic, confidence: 0.5 } };
  }

  return extraction;
}
