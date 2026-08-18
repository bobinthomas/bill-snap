/**
 * D1 demo seed regression (d1/seed.sql, `npm run db:seed`).
 *
 * Runs the committed seed SQL against the same node:sqlite D1 shim the store
 * tests use, then reads the dashboard data — so a JSON typo, a schema drift,
 * or a broken idempotency guard in the seed fails CI immediately, without
 * needing a wrangler D1 session.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { dashboardData, type DashboardData } from "../src/dev/dashboard";
import type { D1Like } from "../src/db/d1";
import { createTestD1 } from "./fakes";

const SEED_SQL = readFileSync(resolve(process.cwd(), "d1/seed.sql"), "utf8");

function runSeed(db: D1Like): void {
  db.exec(SEED_SQL);
}

describe("D1 demo seed (d1/seed.sql)", () => {
  let db: D1Like;

  beforeEach(() => {
    db = createTestD1();
  });

  it("logs the six sample bills with the pipeline's field values", async () => {
    runSeed(db);
    const data = await dashboardData(loadConfig({}), {}, { db });
    expect(data.persistence).toBe("d1");
    expect(data.totals.count).toBe(6);
    expect(data.totals.amount).toBe(3500); // 500 + 2200 + 100 + 340 + 145 + 215
    expect(data.totals.gst).toBe(80); // 10 + 34 + 14.5 + 21.5

    const byVendor = new Map(data.rows.map((r) => [r.vendor, r]));
    expect(byVendor.get("telstra")).toMatchObject({ amount: 100, gst: 10, category: "utilities" });
    expect(byVendor.get("origin")).toMatchObject({ amount: 340, gst: 34, category: "utilities" });
    expect(byVendor.get("rajesh")).toMatchObject({ amount: 500, gst: null, category: "wages" });
    expect(byVendor.get("homebase")).toMatchObject({ amount: 2200, gst: null, category: "rent" });
    expect(byVendor.get("officeworks")).toMatchObject({ amount: 145, gst: 14.5, category: "inventory" });
    expect(byVendor.get("bunnings")).toMatchObject({ amount: 215, gst: 21.5, category: "inventory" });
  });

  it("re-running is idempotent: exactly the six seed bills, no duplicates", async () => {
    runSeed(db);
    runSeed(db);
    runSeed(db);
    const data: DashboardData = await dashboardData(loadConfig({}), {}, { db });
    expect(data.totals.count).toBe(6);
    expect(data.totals.amount).toBe(3500);
    // And the seed rows are the only ones for the demo phone.
    expect(data.rows).toHaveLength(6);
  });

  it("seeds a fresh phone user into the schema (business + owner membership)", async () => {
    runSeed(db);
    const user = await db
      .prepare("select phone_number, business_id from users where phone_number = '61400000111'")
      .first<{ phone_number: string; business_id: string }>();
    expect(user?.business_id).toBe("00000000-0000-4000-8000-000000000001");
    const memberships = await db
      .prepare("select count(*) as n from memberships where user_phone = '61400000111' and role = 'owner'")
      .first<{ n: number }>();
    expect(Number(memberships?.n)).toBe(1);
  });
});
