/**
 * Audit trail for admin edits/deletes of logged bills (§dev/dashboard bills
 * table, migrations/0004_transaction_audit_log.sql). `changedBy` is a
 * constant for now — the dashboard is a single shared-password admin
 * surface with no per-admin identity yet; the column exists so a future
 * real login doesn't need a schema change.
 *
 * Deliberately kept out of RouteDeps/webhook/router.ts — this is an
 * admin-dashboard concern only, not part of the WhatsApp/webapp flow
 * pipeline every other store here is wired into.
 */
import type { D1Like } from "./d1";
import { parseJson } from "./d1";

export const DASHBOARD_ADMIN = "dashboard-admin";

export interface AuditEntry {
  id: string;
  transactionId: string;
  action: "edit" | "delete";
  changes: Record<string, { from: unknown; to: unknown }>;
  changedBy: string;
  createdAt: Date;
}

export interface AuditLogStore {
  record(
    businessId: string | null,
    transactionId: string,
    action: "edit" | "delete",
    changes: Record<string, { from: unknown; to: unknown }>,
  ): Promise<void>;
  /** Most recent entries for a business, newest first. */
  listRecent(businessId: string, limit?: number): Promise<AuditEntry[]>;
}

interface AuditRow {
  id: string;
  transaction_id: string;
  action: "edit" | "delete";
  changes: string;
  changed_by: string;
  created_at: string;
}

export function createD1AuditLogStore(db: D1Like): AuditLogStore {
  return new D1AuditLogStore(db);
}

class D1AuditLogStore implements AuditLogStore {
  constructor(private readonly db: D1Like) {}

  async record(
    businessId: string | null,
    transactionId: string,
    action: "edit" | "delete",
    changes: Record<string, { from: unknown; to: unknown }>,
  ): Promise<void> {
    await this.db
      .prepare(
        "insert into transaction_audit_log (id, transaction_id, business_id, action, changes, changed_by) values (?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), transactionId, businessId, action, JSON.stringify(changes), DASHBOARD_ADMIN)
      .run();
  }

  async listRecent(businessId: string, limit = 50): Promise<AuditEntry[]> {
    // created_at has millisecond resolution — two admin actions in the same
    // millisecond (e.g. an edit immediately followed by a delete) would tie;
    // rowid (implicit, monotonically increasing insertion order) breaks the
    // tie so "newest first" is never ambiguous.
    const { results } = await this.db
      .prepare(
        "select id, transaction_id, action, changes, changed_by, created_at from transaction_audit_log where business_id = ? order by created_at desc, rowid desc limit ?",
      )
      .bind(businessId, limit)
      .all<AuditRow>();
    return results.map(toAuditEntry);
  }
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    action: row.action,
    changes: parseJson<AuditEntry["changes"]>(row.changes, {}),
    changedBy: row.changed_by,
    createdAt: new Date(row.created_at),
  };
}
