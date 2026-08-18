/**
 * users table access (§5.5). The router resolves known vs unknown users through
 * this interface so flows are testable without a live D1 (M3).
 *
 * Backed by Cloudflare D1 (SQLite) — the binding satisfies the narrow D1Like
 * interface; tests pass a node:sqlite shim.
 */
import type { D1Like } from "./d1";

export interface UserRecord {
  phoneNumber: string;
  businessId: string | null;
  createdAt: Date;
}

export interface UserStore {
  findUser(phoneNumber: string): Promise<UserRecord | null>;
}

interface UserRow {
  phone_number: string;
  business_id: string | null;
  created_at: string;
}

export function createD1UserStore(db: D1Like): UserStore {
  return new D1UserStore(db);
}

class D1UserStore implements UserStore {
  constructor(private readonly db: D1Like) {}

  async findUser(phoneNumber: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare("select phone_number, business_id, created_at from users where phone_number = ?")
      .bind(phoneNumber)
      .first<UserRow>();
    return row ? toUserRecord(row) : null;
  }
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    phoneNumber: row.phone_number,
    businessId: row.business_id,
    createdAt: new Date(row.created_at),
  };
}
