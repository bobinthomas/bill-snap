/** Transaction queries: confirm (status → logged), undo (window by path,
 *  §5.6), summary/search scope. TODO(M6)
 *
 *  Vendor-category memory (§extraction/vendor-categories): the episodic half
 *  of the vendor->category memory feature — reads a business's own confirmed
 *  history and hands it to `aggregateVendorCategoryHistory` (pure, D1-free)
 *  so the pipeline can pre-fill a bill's category from what this business has
 *  actually done before. */
import { aggregateVendorCategoryHistory, type VendorCategorySuggestion } from "../extraction/vendor-categories";
import type { D1Like } from "./d1";

export interface TransactionStore {
  /** Per-vendor majority category from this business's own logged/paid
   *  history, keyed by normalizeVendorCase(vendor). Empty map when the
   *  business has no qualifying history yet (falls through to the semantic
   *  dictionary at the caller). */
  getVendorCategoryHistory(businessId: string): Promise<Map<string, VendorCategorySuggestion>>;
}

interface VendorCategoryRow {
  vendor: string;
  category: string;
}

export function createD1TransactionStore(db: D1Like): TransactionStore {
  return new D1TransactionStore(db);
}

class D1TransactionStore implements TransactionStore {
  constructor(private readonly db: D1Like) {}

  async getVendorCategoryHistory(businessId: string): Promise<Map<string, VendorCategorySuggestion>> {
    const { results } = await this.db
      .prepare(
        `select vendor, category
         from transactions
         where business_id = ? and status in ('logged', 'paid') and vendor is not null and category is not null`,
      )
      .bind(businessId)
      .all<VendorCategoryRow>();
    return aggregateVendorCategoryHistory(results);
  }
}
