/**
 * businesses / users / memberships access (§4.5, §5.5).
 *
 * - `onboard` auto-creates the `users` row (phone), a `businesses` row with
 *   sensible defaults, and the owner `memberships` row — nothing blocks the
 *   first bill.
 * - `updateBusiness` powers the `setup` wizard (name → timezone → GST).
 * - `getSetupStep` / `setSetupStep` hold the wizard position per phone (§4.5);
 *   stored on `users.setup_step` (0001_schema.sql).
 */
import type { AppConfig } from "../config";
import { createRestClient, type RestClient } from "./client";
import type { UserRecord } from "./users";

export interface BusinessRecord {
  id: string;
  name: string;
  abn: string | null;
  timezone: string;
  gstRegistered: boolean;
  /** Auto-log High-confidence extractions (§5.8); owner can force always-confirm. */
  autoSave: boolean;
}

export type SetupStep = "name" | "timezone" | "gst";

export interface OnboardedUser {
  user: UserRecord;
  business: BusinessRecord;
}

export interface BusinessPatch {
  name?: string;
  timezone?: string;
  gstRegistered?: boolean;
  autoSave?: boolean;
}

export interface BusinessStore {
  /** Create users + businesses + owner membership. Idempotent: returns existing when already onboarded. */
  onboard(phoneNumber: string): Promise<OnboardedUser>;
  findBusiness(businessId: string): Promise<BusinessRecord | null>;
  updateBusiness(businessId: string, patch: BusinessPatch): Promise<BusinessRecord>;
  getSetupStep(phoneNumber: string): Promise<SetupStep | null>;
  setSetupStep(phoneNumber: string, step: SetupStep | null): Promise<void>;
}

interface BusinessRow {
  id: string;
  name: string;
  abn: string | null;
  timezone: string;
  gst_registered: boolean;
  auto_save: boolean;
  created_at: string;
}

interface UserRow {
  phone_number: string;
  business_id: string | null;
  setup_step: string | null;
  created_at: string;
}

export function createSupabaseBusinessStore(
  config: AppConfig,
  fetchFn?: typeof fetch,
): BusinessStore | null {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;
  return new SupabaseBusinessStore(
    createRestClient({ url: config.supabase.url, key: config.supabase.serviceRoleKey, fetchFn }),
  );
}

class SupabaseBusinessStore implements BusinessStore {
  constructor(private readonly rest: RestClient) {}

  async onboard(phoneNumber: string): Promise<OnboardedUser> {
    // Already onboarded → return existing (idempotent, §4.5).
    const existing = await this.findUserRow(phoneNumber);
    if (existing?.business_id) {
      const business = await this.findBusiness(existing.business_id);
      if (business) return { user: toUserRecord(existing), business };
    }

    // Business first (users.business_id FK), then the user, then the owner
    // membership. `ignore-duplicates` keeps each step safe under concurrent
    // first-message deliveries (phone_number / membership are unique keys).
    const businessRows = await this.rest.insert<BusinessRow>(
      "businesses",
      {
        name: "My Business",
        timezone: "Australia/Sydney",
        gst_registered: true,
        auto_save: true,
      },
      { returnRepresentation: true },
    );
    const businessRow = businessRows?.[0];
    if (!businessRow) throw new Error("onboard: failed to create business");

    await this.rest.insert<UserRow>(
      "users",
      { phone_number: phoneNumber, business_id: businessRow.id },
      { ignoreDuplicates: true },
    );

    await this.rest.insert(
      "memberships",
      { business_id: businessRow.id, user_phone: phoneNumber, role: "owner" },
      { ignoreDuplicates: true },
    );

    const userRow = (await this.findUserRow(phoneNumber))!;
    return { user: toUserRecord(userRow), business: toBusinessRecord(businessRow) };
  }

  async findBusiness(businessId: string): Promise<BusinessRecord | null> {
    const rows = await this.rest.select<BusinessRow>("businesses", {
      id: `eq.${businessId}`,
      select: "id,name,abn,timezone,gst_registered,auto_save",
      limit: "1",
    });
    const row = rows[0];
    return row ? toBusinessRecord(row) : null;
  }

  async updateBusiness(businessId: string, patch: BusinessPatch): Promise<BusinessRecord> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.timezone !== undefined) body.timezone = patch.timezone;
    if (patch.gstRegistered !== undefined) body.gst_registered = patch.gstRegistered;
    if (patch.autoSave !== undefined) body.auto_save = patch.autoSave;

    const rows = await this.rest.update<BusinessRow>("businesses", body, { id: `eq.${businessId}` });
    const row = rows?.[0];
    if (!row) throw new Error(`updateBusiness: business ${businessId} not found`);
    return toBusinessRecord(row);
  }

  async getSetupStep(phoneNumber: string): Promise<SetupStep | null> {
    const row = await this.findUserRow(phoneNumber);
    const step = row?.setup_step;
    if (step === "name" || step === "timezone" || step === "gst") return step;
    return null;
  }

  async setSetupStep(phoneNumber: string, step: SetupStep | null): Promise<void> {
    await this.rest.update("users", { setup_step: step }, { phone_number: `eq.${phoneNumber}` });
  }

  private async findUserRow(phoneNumber: string): Promise<UserRow | null> {
    const rows = await this.rest.select<UserRow>("users", {
      phone_number: `eq.${phoneNumber}`,
      select: "phone_number,business_id,setup_step,created_at",
      limit: "1",
    });
    return rows[0] ?? null;
  }
}

function toBusinessRecord(row: BusinessRow): BusinessRecord {
  return {
    id: row.id,
    name: row.name,
    abn: row.abn,
    timezone: row.timezone,
    gstRegistered: row.gst_registered,
    autoSave: row.auto_save,
  };
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    phoneNumber: row.phone_number,
    businessId: row.business_id,
    createdAt: new Date(row.created_at),
  };
}
