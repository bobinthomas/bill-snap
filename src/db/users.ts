/**
 * users table access (§5.5). The router resolves known vs unknown users through
 * this interface so flows are testable without Supabase (M3).
 */
import type { AppConfig } from "../config";
import { createRestClient, type RestClient } from "./client";

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
  setup_step: string | null;
  created_at: string;
}

export function createSupabaseUserStore(
  config: AppConfig,
  fetchFn?: typeof fetch,
): UserStore | null {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;
  return new SupabaseUserStore(
    createRestClient({ url: config.supabase.url, key: config.supabase.serviceRoleKey, fetchFn }),
  );
}

class SupabaseUserStore implements UserStore {
  constructor(private readonly rest: RestClient) {}

  async findUser(phoneNumber: string): Promise<UserRecord | null> {
    const rows = await this.rest.select<UserRow>("users", {
      phone_number: `eq.${phoneNumber}`,
      select: "phone_number,business_id,created_at",
      limit: "1",
    });
    const row = rows[0];
    if (!row) return null;
    return {
      phoneNumber: row.phone_number,
      businessId: row.business_id,
      createdAt: new Date(row.created_at),
    };
  }
}
