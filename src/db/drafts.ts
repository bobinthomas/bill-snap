/**
 * Draft lifecycle storage (§5.6). Drafts are `transactions` rows; this store
 * exposes the flow-facing operations and the undo lookup.
 *
 * - `createDraft` is idempotent: `(user_phone, wa_message_id)` is unique (partial
 *   index on `status = 'draft'`), so a retried webhook delivery returns `null`
 *   instead of double-processing.
 * - `findActiveDraft` returns the user's newest non-expired draft.
 * - `confirm` / `expire` / `softDeleteLogged` model the status transitions
 *   (`draft` → `logged` / `expired` / `deleted`, §5.6/§5.8). Confirming also
 *   denormalises the extracted fields onto the transaction row so summaries
 *   (§4.3), search, and the accountant export read plain columns.
 */
import type { AppConfig } from "../config";
import type { FlowState, GatingLevel } from "../types";
import type { BillExtraction } from "../types";
import { createRestClient, type RestClient } from "./client";

export type DraftStatus = "draft" | "logged" | "expired" | "deleted" | "paid";

export interface DraftRecord {
  id: string;
  userPhone: string;
  waMessageId: string;
  /** null once logged (§5.5: "null once logged"). */
  flowState: FlowState | null;
  flowExpiresAt: Date;
  imageUrls: string[];
  createdAt: Date;
  status: DraftStatus;
  /** Extraction outcome (M5+). Mirrors `transactions.raw_extraction` + gating. */
  extraction?: BillExtraction;
  gateLevel?: GatingLevel;
  machineRead?: boolean;
  confirmedAt?: Date;
  /** True when the transaction was auto-logged (§5.8, M7) — grants the 24 h undo window. */
  autoLogged?: boolean;
  /** When the confirm-screen nudge was sent (null until then; one-nudge cap, §6.2). */
  flowNudgedAt?: Date;
}

export interface CreateDraftInput {
  userPhone: string;
  waMessageId: string;
  imageUrls: string[];
  flowExpiresAt: Date;
}

export interface FlowPatch {
  flowState: FlowState;
  extraction?: BillExtraction;
  gateLevel?: GatingLevel;
  machineRead?: boolean;
  /** Supabase storage URLs after the M8 upload; replaces the WhatsApp media IDs. */
  imageUrls?: string[];
}

export interface ConfirmOptions {
  /** True for the §5.8 auto-log path — grants the 24 h undo window. */
  autoLogged?: boolean;
}

/**
 * §5.8 duplicate predicate — the matching rule behind `findDuplicate`. Pure, so
 * the SQL query, the test fake, and the eval corpus check all share one
 * definition. `candidate` is the bill about to be auto-logged; `prev` is an
 * already-logged transaction.
 *
 * Mirrors `findDuplicate` exactly: a match is (candidate invoice number equals
 * prev's) OR (candidate has vendor+amount and both equal prev's).
 */
export interface DuplicateCandidate {
  invoiceNumber: string | null;
  vendor: string | null;
  amount: number | null;
}

export function isDuplicateMatch(prev: DuplicateCandidate, candidate: DuplicateCandidate): boolean {
  if (candidate.invoiceNumber !== null && prev.invoiceNumber === candidate.invoiceNumber) return true;
  if (
    candidate.vendor !== null &&
    candidate.amount !== null &&
    prev.vendor === candidate.vendor &&
    prev.amount === candidate.amount
  ) {
    return true;
  }
  return false;
}

export function toDuplicateCandidate(extraction: BillExtraction): DuplicateCandidate {
  return {
    invoiceNumber: extraction.invoice_number.value,
    vendor: extraction.vendor.value,
    amount: extraction.amount.value,
  };
}

export interface DraftStore {
  /** Returns null when a draft already exists for (userPhone, waMessageId). */
  createDraft(input: CreateDraftInput): Promise<DraftRecord | null>;
  /** Newest draft with `status: draft` and `flow_expires_at > now`, or null. */
  findActiveDraft(userPhone: string, now?: Date): Promise<DraftRecord | null>;
  /** Persist a flow transition; returns the updated record. */
  setFlowState(id: string, patch: FlowPatch): Promise<DraftRecord>;
  /** status: draft → logged, flow_state → null, confirmed_at → given time. */
  confirm(id: string, confirmedAt: Date, opts?: ConfirmOptions): Promise<DraftRecord | null>;
  /** status → expired (skip / wrong bill / new-photo cancel). */
  expire(id: string): Promise<void>;
  /** Newest logged/paid transaction for the user with confirmed_at ≥ within. */
  findRecentLogged(userPhone: string, within: Date): Promise<DraftRecord | null>;
  /** Logged/paid transactions, newest first — dashboard/summaries (§4.3). */
  listLogged(userPhone: string, limit?: number): Promise<DraftRecord[]>;
  /** §5.8 duplicate gate: any logged match per `isDuplicateMatch`, within the window. */
  findDuplicate(userPhone: string, extraction: BillExtraction, within: Date): Promise<DraftRecord | null>;
  /** status: logged/paid → deleted (soft delete per §7.4). */
  softDeleteLogged(id: string): Promise<void>;
  /** Awaiting-reply drafts, never nudged, inside the nudge window (expires in ≤ window, not yet expired). */
  findNudgeDue(now: Date, nudgeWindowMs: number): Promise<DraftRecord[]>;
  /** Set flow_nudged_at — enforces the one-nudge cap (§6.2). */
  markNudged(id: string, nudgedAt: Date): Promise<void>;
  /** Flip drafts past flow_expires_at to status expired; returns the count (§5.6). */
  expireDue(now: Date): Promise<number>;
}

const DRAFT_COLUMNS =
  "id,user_phone,wa_message_id,flow_state,flow_expires_at,image_urls,created_at,status," +
  "raw_extraction,gate_level,machine_read,auto_logged,confirmed_at,flow_nudged_at";

interface TransactionRow {
  id: string;
  user_phone: string;
  wa_message_id: string;
  flow_state: FlowState | null;
  flow_expires_at: string | null;
  image_urls: unknown;
  created_at: string;
  status: DraftStatus;
  raw_extraction: BillExtraction | null;
  gate_level: GatingLevel | null;
  machine_read: boolean | null;
  auto_logged: boolean | null;
  confirmed_at: string | null;
  flow_nudged_at: string | null;
}

export function createSupabaseDraftStore(
  config: AppConfig,
  fetchFn?: typeof fetch,
): DraftStore | null {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;
  return new SupabaseDraftStore(
    createRestClient({ url: config.supabase.url, key: config.supabase.serviceRoleKey, fetchFn }),
  );
}

class SupabaseDraftStore implements DraftStore {
  constructor(private readonly rest: RestClient) {}

  async createDraft(input: CreateDraftInput): Promise<DraftRecord | null> {
    const rows = await this.rest.insert<TransactionRow>(
      "transactions",
      {
        user_phone: input.userPhone,
        wa_message_id: input.waMessageId,
        image_urls: input.imageUrls,
        flow_state: "processing",
        flow_expires_at: input.flowExpiresAt.toISOString(),
        status: "draft",
      },
      { returnRepresentation: true, ignoreDuplicates: true },
    );
    const row = rows?.[0];
    return row ? toDraftRecord(row) : null;
  }

  async findActiveDraft(userPhone: string, now = new Date()): Promise<DraftRecord | null> {
    const rows = await this.rest.select<TransactionRow>("transactions", {
      select: DRAFT_COLUMNS,
      user_phone: `eq.${userPhone}`,
      status: "eq.draft",
      flow_expires_at: `gt.${now.toISOString()}`,
      order: "created_at.desc",
      limit: "1",
    });
    const row = rows[0];
    return row ? toDraftRecord(row) : null;
  }

  async setFlowState(id: string, patch: FlowPatch): Promise<DraftRecord> {
    const body: Record<string, unknown> = { flow_state: patch.flowState };
    if (patch.extraction !== undefined) body.raw_extraction = patch.extraction;
    if (patch.gateLevel !== undefined) body.gate_level = patch.gateLevel;
    if (patch.machineRead !== undefined) body.machine_read = patch.machineRead;
    if (patch.imageUrls !== undefined) body.image_urls = patch.imageUrls;

    const rows = await this.rest.update<TransactionRow>("transactions", body, {
      id: `eq.${id}`,
      select: DRAFT_COLUMNS,
    });
    const row = rows?.[0];
    if (!row) throw new Error(`setFlowState: draft ${id} not found`);
    return toDraftRecord(row);
  }

  async confirm(id: string, confirmedAt: Date, opts: ConfirmOptions = {}): Promise<DraftRecord | null> {
    const before = await this.getRow(id);
    if (!before) return null;

    const e = before.raw_extraction;
    const rows = await this.rest.update<TransactionRow>(
      "transactions",
      {
        status: "logged",
        flow_state: null,
        confirmed_at: confirmedAt.toISOString(),
        auto_logged: opts.autoLogged ?? false,
        // Denormalise the extraction so summaries/search read plain columns (§5.5).
        amount: e?.amount.value ?? null,
        gst: e?.gst.value ?? null,
        category: e?.category_hint?.value ?? "misc",
        vendor: e?.vendor.value ?? null,
        abn: e?.abn.value ?? null,
        invoice_number: e?.invoice_number.value ?? null,
        due_date: e?.due_date.value ?? null,
      },
      { id: `eq.${id}`, select: DRAFT_COLUMNS },
    );
    const row = rows?.[0];
    return row ? toDraftRecord(row) : null;
  }

  async expire(id: string): Promise<void> {
    await this.rest.update("transactions", { status: "expired", flow_state: null }, { id: `eq.${id}` });
  }

  async findRecentLogged(userPhone: string, within: Date): Promise<DraftRecord | null> {
    const rows = await this.rest.select<TransactionRow>("transactions", {
      select: DRAFT_COLUMNS,
      user_phone: `eq.${userPhone}`,
      status: "in.(logged,paid)",
      confirmed_at: `gte.${within.toISOString()}`,
      order: "confirmed_at.desc",
      limit: "1",
    });
    const row = rows[0];
    return row ? toDraftRecord(row) : null;
  }

  async listLogged(userPhone: string, limit = 100): Promise<DraftRecord[]> {
    const rows = await this.rest.select<TransactionRow>("transactions", {
      select: DRAFT_COLUMNS,
      user_phone: `eq.${userPhone}`,
      status: "in.(logged,paid)",
      order: "confirmed_at.desc",
      limit: String(limit),
    });
    return rows.map(toDraftRecord);
  }

  async findDuplicate(
    userPhone: string,
    extraction: BillExtraction,
    within: Date,
  ): Promise<DraftRecord | null> {
    // Mirrors isDuplicateMatch: invoice-number branch, then vendor + amount.
    const base = {
      select: DRAFT_COLUMNS,
      user_phone: `eq.${userPhone}`,
      status: "in.(logged,paid)",
      confirmed_at: `gte.${within.toISOString()}`,
    };

    const inv = extraction.invoice_number.value;
    if (inv !== null) {
      const rows = await this.rest.select<TransactionRow>("transactions", {
        ...base,
        invoice_number: `eq.${inv}`,
        limit: "1",
      });
      const row = rows[0];
      if (row) return toDraftRecord(row);
    }

    const vendor = extraction.vendor.value;
    const amount = extraction.amount.value;
    if (vendor !== null && amount !== null) {
      const rows = await this.rest.select<TransactionRow>("transactions", {
        ...base,
        vendor: `eq.${vendor}`,
        amount: `eq.${amount}`,
        limit: "1",
      });
      const row = rows[0];
      if (row) return toDraftRecord(row);
    }

    return null;
  }

  async softDeleteLogged(id: string): Promise<void> {
    await this.rest.update("transactions", { status: "deleted" }, { id: `eq.${id}` });
  }

  async findNudgeDue(now: Date, nudgeWindowMs: number): Promise<DraftRecord[]> {
    const windowEnd = new Date(now.getTime() + nudgeWindowMs);
    // Same column twice → one `and=(...)` expression (PostgREST has one key per column).
    const range = `(flow_expires_at.gt.${now.toISOString()},flow_expires_at.lte.${windowEnd.toISOString()})`;
    const rows = await this.rest.select<TransactionRow>("transactions", {
      select: DRAFT_COLUMNS,
      status: "eq.draft",
      flow_nudged_at: "is.null",
      and: range,
      flow_state: "in.(awaiting_confirm,editing_amount,editing_vendor,editing_date)",
    });
    return rows.map(toDraftRecord);
  }

  async markNudged(id: string, nudgedAt: Date): Promise<void> {
    await this.rest.update("transactions", { flow_nudged_at: nudgedAt.toISOString() }, { id: `eq.${id}` });
  }

  async expireDue(now: Date): Promise<number> {
    return this.rest.updateCount(
      "transactions",
      { status: "expired", flow_state: null },
      { status: "eq.draft", flow_expires_at: `lte.${now.toISOString()}` },
    );
  }

  private async getRow(id: string): Promise<TransactionRow | null> {
    const rows = await this.rest.select<TransactionRow>("transactions", {
      select: DRAFT_COLUMNS,
      id: `eq.${id}`,
      limit: "1",
    });
    return rows[0] ?? null;
  }
}

function toDraftRecord(row: TransactionRow): DraftRecord {
  return {
    id: row.id,
    userPhone: row.user_phone,
    waMessageId: row.wa_message_id,
    flowState: row.flow_state,
    flowExpiresAt: new Date(row.flow_expires_at ?? row.created_at),
    imageUrls: Array.isArray(row.image_urls) ? (row.image_urls as string[]) : [],
    createdAt: new Date(row.created_at),
    status: row.status,
    extraction: row.raw_extraction ?? undefined,
    gateLevel: row.gate_level ?? undefined,
    machineRead: row.machine_read ?? undefined,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : undefined,
    autoLogged: row.auto_logged ?? undefined,
    flowNudgedAt: row.flow_nudged_at ? new Date(row.flow_nudged_at) : undefined,
  };
}
