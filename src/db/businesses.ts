/**
 * businesses / users / memberships access (§4.5, §5.5).
 *
 * - `onboard` auto-creates the `users` row (phone), a `businesses` row with
 *   sensible defaults, and the owner `memberships` row — nothing blocks the
 *   first bill. Idempotent: a retried first message returns the existing rows.
 * - `updateBusiness` powers the `setup` wizard (name → timezone → GST).
 * - `getSetupStep` / `setSetupStep` hold the wizard position per phone (§4.5);
 *   stored on `users.setup_step`.
 *
 * Backed by Cloudflare D1 (SQLite). IDs are generated with crypto.randomUUID()
 * in JS (D1 has no gen_random_uuid); timestamps are ISO strings (lexicographic
 * order matches Postgres timestamptz semantics the flows rely on).
 */
import type { D1Like } from "./d1";
import type { UserRecord } from "./users";

export interface BusinessRecord {
  id: string;
  name: string;
  abn: string | null;
  /** Separate from the ABN — some businesses register a distinct GST number. */
  gstNumber: string | null;
  timezone: string;
  gstRegistered: boolean;
  /** Auto-log High-confidence extractions (§5.8); owner can force always-confirm. */
  autoSave: boolean;
  address: string | null;
  /** Business contact number — distinct from users.phone_number (the WhatsApp/webapp identity). */
  phone: string | null;
  createdAt: Date;
}

export type SetupStep = "name" | "timezone" | "gst";

export interface OnboardedUser {
  user: UserRecord;
  business: BusinessRecord;
}

export interface BusinessPatch {
  name?: string;
  abn?: string;
  gstNumber?: string;
  timezone?: string;
  gstRegistered?: boolean;
  autoSave?: boolean;
  address?: string;
  phone?: string;
}

/** A business's owner/staff roster (§5.5 multi-user). */
export interface MembershipRecord {
  userPhone: string;
  role: "owner" | "staff";
  createdAt: Date;
}

export interface BusinessStore {
  /** Create users + businesses + owner membership. Idempotent: returns existing when already onboarded. */
  onboard(phoneNumber: string): Promise<OnboardedUser>;
  findBusiness(businessId: string): Promise<BusinessRecord | null>;
  updateBusiness(businessId: string, patch: BusinessPatch): Promise<BusinessRecord>;
  getSetupStep(phoneNumber: string): Promise<SetupStep | null>;
  setSetupStep(phoneNumber: string, step: SetupStep | null): Promise<void>;
  /** Owner + staff roster for the settings page's Team members section. */
  listMembers(businessId: string): Promise<MembershipRecord[]>;
  /** Every company, name-ordered — the company picker/switcher's source list. */
  listAll(): Promise<BusinessRecord[]>;
  /** Binds a phone/device to an EXISTING company: upserts the users row and
   *  adds an owner membership if one doesn't already exist. Returns null
   *  when businessId doesn't exist. Distinct from onboard(), which always
   *  creates a NEW company — this one only ever attaches to one already
   *  there (the company picker/switcher's "select existing" path). */
  assignBusiness(phoneNumber: string, businessId: string): Promise<BusinessRecord | null>;
}

interface BusinessRow {
  id: string;
  name: string;
  abn: string | null;
  gst_number: string | null;
  timezone: string;
  gst_registered: number;
  auto_save: number;
  address: string | null;
  phone: string | null;
  created_at: string;
}

interface MembershipRow {
  user_phone: string;
  role: "owner" | "staff";
  created_at: string;
}

interface UserRow {
  phone_number: string;
  business_id: string | null;
  setup_step: string | null;
  created_at: string;
}

export function createD1BusinessStore(db: D1Like): BusinessStore {
  return new D1BusinessStore(db);
}

class D1BusinessStore implements BusinessStore {
  constructor(private readonly db: D1Like) {}

  async onboard(phoneNumber: string): Promise<OnboardedUser> {
    // Already onboarded → return existing (idempotent, §4.5).
    const existing = await this.findUserRow(phoneNumber);
    if (existing?.business_id) {
      const business = await this.findBusiness(existing.business_id);
      if (business) return { user: toUserRecord(existing), business };
    }

    // Business first (users.business_id FK), then the user, then the owner
    // membership. INSERT OR IGNORE keeps each step safe under concurrent
    // first-message deliveries (phone_number / membership are unique keys).
    const businessId = crypto.randomUUID();
    await this.db
      .prepare(
        "insert into businesses (id, name, timezone, gst_registered, auto_save) values (?, ?, ?, 1, 1)",
      )
      .bind(businessId, "My Business", "Australia/Sydney")
      .run();

    await this.db
      .prepare("insert or ignore into users (phone_number, business_id) values (?, ?)")
      .bind(phoneNumber, businessId)
      .run();

    await this.db
      .prepare(
        "insert or ignore into memberships (id, business_id, user_phone, role) values (?, ?, ?, 'owner')",
      )
      .bind(crypto.randomUUID(), businessId, phoneNumber)
      .run();

    const userRow = (await this.findUserRow(phoneNumber))!;
    const business = (await this.findBusiness(businessId))!;
    return { user: toUserRecord(userRow), business };
  }

  async findBusiness(businessId: string): Promise<BusinessRecord | null> {
    const row = await this.db
      .prepare(
        "select id, name, abn, gst_number, timezone, gst_registered, auto_save, address, phone, created_at from businesses where id = ?",
      )
      .bind(businessId)
      .first<BusinessRow>();
    return row ? toBusinessRecord(row) : null;
  }

  async updateBusiness(businessId: string, patch: BusinessPatch): Promise<BusinessRecord> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.abn !== undefined) {
      sets.push("abn = ?");
      values.push(patch.abn);
    }
    if (patch.gstNumber !== undefined) {
      sets.push("gst_number = ?");
      values.push(patch.gstNumber);
    }
    if (patch.timezone !== undefined) {
      sets.push("timezone = ?");
      values.push(patch.timezone);
    }
    if (patch.gstRegistered !== undefined) {
      sets.push("gst_registered = ?");
      values.push(patch.gstRegistered ? 1 : 0);
    }
    if (patch.autoSave !== undefined) {
      sets.push("auto_save = ?");
      values.push(patch.autoSave ? 1 : 0);
    }
    if (patch.address !== undefined) {
      sets.push("address = ?");
      values.push(patch.address);
    }
    if (patch.phone !== undefined) {
      sets.push("phone = ?");
      values.push(patch.phone);
    }
    if (sets.length === 0) {
      const existing = await this.findBusiness(businessId);
      if (!existing) throw new Error(`updateBusiness: business ${businessId} not found`);
      return existing;
    }

    const row = await this.db
      .prepare(
        `update businesses set ${sets.join(", ")} where id = ? returning id, name, abn, gst_number, timezone, gst_registered, auto_save, address, phone, created_at`,
      )
      .bind(...values, businessId)
      .first<BusinessRow>();
    if (!row) throw new Error(`updateBusiness: business ${businessId} not found`);
    return toBusinessRecord(row);
  }

  async listMembers(businessId: string): Promise<MembershipRecord[]> {
    const { results } = await this.db
      .prepare("select user_phone, role, created_at from memberships where business_id = ? order by created_at asc")
      .bind(businessId)
      .all<MembershipRow>();
    return results.map((r) => ({ userPhone: r.user_phone, role: r.role, createdAt: new Date(r.created_at) }));
  }

  async listAll(): Promise<BusinessRecord[]> {
    const { results } = await this.db
      .prepare(
        "select id, name, abn, gst_number, timezone, gst_registered, auto_save, address, phone, created_at from businesses order by name",
      )
      .all<BusinessRow>();
    return results.map(toBusinessRecord);
  }

  async assignBusiness(phoneNumber: string, businessId: string): Promise<BusinessRecord | null> {
    const business = await this.findBusiness(businessId);
    if (!business) return null;
    await this.db
      .prepare(
        "insert into users (phone_number, business_id) values (?, ?) on conflict(phone_number) do update set business_id = excluded.business_id",
      )
      .bind(phoneNumber, businessId)
      .run();
    await this.db
      .prepare(
        "insert or ignore into memberships (id, business_id, user_phone, role) values (?, ?, ?, 'owner')",
      )
      .bind(crypto.randomUUID(), businessId, phoneNumber)
      .run();
    return business;
  }

  async getSetupStep(phoneNumber: string): Promise<SetupStep | null> {
    const row = await this.findUserRow(phoneNumber);
    const step = row?.setup_step;
    if (step === "name" || step === "timezone" || step === "gst") return step;
    return null;
  }

  async setSetupStep(phoneNumber: string, step: SetupStep | null): Promise<void> {
    await this.db
      .prepare("update users set setup_step = ? where phone_number = ?")
      .bind(step, phoneNumber)
      .run();
  }

  private async findUserRow(phoneNumber: string): Promise<UserRow | null> {
    return this.db
      .prepare("select phone_number, business_id, setup_step, created_at from users where phone_number = ?")
      .bind(phoneNumber)
      .first<UserRow>();
  }
}

function toBusinessRecord(row: BusinessRow): BusinessRecord {
  return {
    id: row.id,
    name: row.name,
    abn: row.abn,
    gstNumber: row.gst_number,
    timezone: row.timezone,
    gstRegistered: row.gst_registered === 1,
    autoSave: row.auto_save === 1,
    address: row.address,
    phone: row.phone,
    createdAt: new Date(row.created_at),
  };
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    phoneNumber: row.phone_number,
    businessId: row.business_id,
    createdAt: new Date(row.created_at),
  };
}
