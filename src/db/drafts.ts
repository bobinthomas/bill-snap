/**
 * Draft lifecycle storage (§5.6). Drafts are `transactions` rows; this store
 * exposes the flow-facing operations and the undo lookup.
 *
 * - `createDraft` is idempotent: `(user_phone, wa_message_id)` is unique while
 *   `status = 'draft'` (partial unique index, migrations/0001_schema.sql), so
 *   a retried webhook delivery returns `null` instead of double-processing.
 * - `findActiveDraft` returns the user's newest non-expired draft.
 * - `confirm` / `expire` / `softDeleteLogged` model the status transitions
 *   (`draft` → `logged` / `expired` / `deleted`, §5.6/§5.8). Confirming also
 *   denormalises the extracted fields onto the transaction row so summaries
 *   (§4.3), search, and the accountant export read plain columns.
 *
 * Backed by Cloudflare D1 (SQLite): ISO-8601 timestamps as TEXT, booleans as
 * INTEGER 0/1, image_urls / raw_extraction as JSON strings. Timestamps are
 * compared lexicographically (same ISO format everywhere).
 */
import type { FlowState, GatingLevel } from "../types";
import type { BillExtraction } from "../types";
import { parseJson, type D1Like } from "./d1";

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
  /** R2 URLs after the M8 upload; replaces the WhatsApp media IDs. */
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
  image_urls: string;
  created_at: string;
  status: DraftStatus;
  raw_extraction: string | null;
  gate_level: GatingLevel | null;
  machine_read: number | null;
  auto_logged: number | null;
  confirmed_at: string | null;
  flow_nudged_at: string | null;
}

export function createD1DraftStore(db: D1Like): DraftStore {
  return new D1DraftStore(db);
}

class D1DraftStore implements DraftStore {
  constructor(private readonly db: D1Like) {}

  async createDraft(input: CreateDraftInput): Promise<DraftRecord | null> {
    const id = crypto.randomUUID();
    const res = await this.db
      .prepare(
        "insert or ignore into transactions (id, user_phone, wa_message_id, image_urls, flow_state, flow_expires_at, status) values (?, ?, ?, ?, 'processing', ?, 'draft')",
      )
      .bind(
        id,
        input.userPhone,
        input.waMessageId,
        JSON.stringify(input.imageUrls),
        input.flowExpiresAt.toISOString(),
      )
      .run();
    // changes === 0 → the partial unique index rejected the insert (retried
    // delivery); return null so the flow treats it as already-processed.
    if (res.meta.changes === 0) return null;
    const row = await this.getRow(id);
    return row ? toDraftRecord(row) : null;
  }

  async findActiveDraft(userPhone: string, now = new Date()): Promise<DraftRecord | null> {
    const row = await this.db
      .prepare(
        `select ${DRAFT_COLUMNS} from transactions where user_phone = ? and status = 'draft' and flow_expires_at > ? order by created_at desc limit 1`,
      )
      .bind(userPhone, now.toISOString())
      .first<TransactionRow>();
    return row ? toDraftRecord(row) : null;
  }

  async setFlowState(id: string, patch: FlowPatch): Promise<DraftRecord> {
    const sets: string[] = ["flow_state = ?"];
    const values: unknown[] = [patch.flowState];
    if (patch.extraction !== undefined) {
      sets.push("raw_extraction = ?");
      values.push(JSON.stringify(patch.extraction));
    }
    if (patch.gateLevel !== undefined) {
      sets.push("gate_level = ?");
      values.push(patch.gateLevel);
    }
    if (patch.machineRead !== undefined) {
      sets.push("machine_read = ?");
      values.push(patch.machineRead ? 1 : 0);
    }
    if (patch.imageUrls !== undefined) {
      sets.push("image_urls = ?");
      values.push(JSON.stringify(patch.imageUrls));
    }

    const row = await this.db
      .prepare(`update transactions set ${sets.join(", ")} where id = ? returning ${DRAFT_COLUMNS}`)
      .bind(...values, id)
      .first<TransactionRow>();
    if (!row) throw new Error(`setFlowState: draft ${id} not found`);
    return toDraftRecord(row);
  }

  async confirm(id: string, confirmedAt: Date, opts: ConfirmOptions = {}): Promise<DraftRecord | null> {
    const before = await this.getRow(id);
    if (!before) return null;

    const e = before.raw_extraction ? parseJson<BillExtraction>(before.raw_extraction, null as never) : null;
    const row = await this.db
      .prepare(
        `update transactions set status = 'logged', flow_state = null, confirmed_at = ?, auto_logged = ?,
           amount = ?, gst = ?, category = ?, vendor = ?, abn = ?, invoice_number = ?, due_date = ?
         where id = ? returning ${DRAFT_COLUMNS}`,
      )
      .bind(
        confirmedAt.toISOString(),
        opts.autoLogged ? 1 : 0,
        e?.amount.value ?? null,
        e?.gst.value ?? null,
        e?.category_hint?.value ?? "misc",
        e?.vendor.value ?? null,
        e?.abn.value ?? null,
        e?.invoice_number.value ?? null,
        e?.due_date.value ?? null,
        id,
      )
      .first<TransactionRow>();
    return row ? toDraftRecord(row) : null;
  }

  async expire(id: string): Promise<void> {
    await this.db
      .prepare("update transactions set status = 'expired', flow_state = null where id = ?")
      .bind(id)
      .run();
  }

  async findRecentLogged(userPhone: string, within: Date): Promise<DraftRecord | null> {
    const row = await this.db
      .prepare(
        `select ${DRAFT_COLUMNS} from transactions where user_phone = ? and status in ('logged', 'paid') and confirmed_at >= ? order by confirmed_at desc limit 1`,
      )
      .bind(userPhone, within.toISOString())
      .first<TransactionRow>();
    return row ? toDraftRecord(row) : null;
  }

  async listLogged(userPhone: string, limit = 100): Promise<DraftRecord[]> {
    const res = await this.db
      .prepare(
        `select ${DRAFT_COLUMNS} from transactions where user_phone = ? and status in ('logged', 'paid') order by confirmed_at desc limit ?`,
      )
      .bind(userPhone, limit)
      .all<TransactionRow>();
    return res.results.map(toDraftRecord);
  }

  async findDuplicate(
    userPhone: string,
    extraction: BillExtraction,
    within: Date,
  ): Promise<DraftRecord | null> {
    // Mirrors isDuplicateMatch: invoice-number branch, then vendor + amount.
    const inv = extraction.invoice_number.value;
    if (inv !== null) {
      const row = await this.db
        .prepare(
          `select ${DRAFT_COLUMNS} from transactions where user_phone = ? and status in ('logged', 'paid') and confirmed_at >= ? and invoice_number = ? limit 1`,
        )
        .bind(userPhone, within.toISOString(), inv)
        .first<TransactionRow>();
      if (row) return toDraftRecord(row);
    }

    const vendor = extraction.vendor.value;
    const amount = extraction.amount.value;
    if (vendor !== null && amount !== null) {
      const row = await this.db
        .prepare(
          `select ${DRAFT_COLUMNS} from transactions where user_phone = ? and status in ('logged', 'paid') and confirmed_at >= ? and vendor = ? and amount = ? limit 1`,
        )
        .bind(userPhone, within.toISOString(), vendor, amount)
        .first<TransactionRow>();
      if (row) return toDraftRecord(row);
    }

    return null;
  }

  async softDeleteLogged(id: string): Promise<void> {
    await this.db.prepare("update transactions set status = 'deleted' where id = ?").bind(id).run();
  }

  async findNudgeDue(now: Date, nudgeWindowMs: number): Promise<DraftRecord[]> {
    const windowEnd = new Date(now.getTime() + nudgeWindowMs);
    const res = await this.db
      .prepare(
        `select ${DRAFT_COLUMNS} from transactions
         where status = 'draft' and flow_nudged_at is null
           and flow_expires_at > ? and flow_expires_at <= ?
           and flow_state in ('awaiting_confirm', 'editing_amount', 'editing_vendor', 'editing_date')`,
      )
      .bind(now.toISOString(), windowEnd.toISOString())
      .all<TransactionRow>();
    return res.results.map(toDraftRecord);
  }

  async markNudged(id: string, nudgedAt: Date): Promise<void> {
    await this.db.prepare("update transactions set flow_nudged_at = ? where id = ?").bind(nudgedAt.toISOString(), id).run();
  }

  async expireDue(now: Date): Promise<number> {
    const res = await this.db
      .prepare("update transactions set status = 'expired', flow_state = null where status = 'draft' and flow_expires_at <= ?")
      .bind(now.toISOString())
      .run();
    return res.meta.changes;
  }

  private async getRow(id: string): Promise<TransactionRow | null> {
    return this.db
      .prepare(`select ${DRAFT_COLUMNS} from transactions where id = ?`)
      .bind(id)
      .first<TransactionRow>();
  }
}

function toDraftRecord(row: TransactionRow): DraftRecord {
  return {
    id: row.id,
    userPhone: row.user_phone,
    waMessageId: row.wa_message_id,
    flowState: row.flow_state,
    flowExpiresAt: new Date(row.flow_expires_at ?? row.created_at),
    imageUrls: parseJson<string[]>(row.image_urls, []),
    createdAt: new Date(row.created_at),
    status: row.status,
    extraction: row.raw_extraction ? parseJson<BillExtraction | null>(row.raw_extraction, null) ?? undefined : undefined,
    gateLevel: row.gate_level ?? undefined,
    machineRead: row.machine_read === null ? undefined : row.machine_read === 1,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : undefined,
    autoLogged: row.auto_logged === null ? undefined : row.auto_logged === 1,
    flowNudgedAt: row.flow_nudged_at ? new Date(row.flow_nudged_at) : undefined,
  };
}
