import { describe, expect, it } from "vitest";
import { createD1AuditLogStore } from "../src/db/audit";
import { createD1DraftStore } from "../src/db/drafts";
import { createTestD1 } from "./fakes";

const PHONE = "61412345678";
const BIZ = "11111111-1111-4111-8111-111111111111";
const BIZ2 = "22222222-2222-4222-8222-222222222222";

function seedUser(db: ReturnType<typeof createTestD1>, phone: string, businessId: string): void {
  db.prepare("insert or ignore into businesses (id, name, timezone) values (?, ?, ?)")
    .bind(businessId, "My Business", "Australia/Sydney")
    .run();
  db.prepare("insert or ignore into users (phone_number, business_id) values (?, ?)").bind(phone, businessId).run();
}

async function makeLoggedTransaction(db: ReturnType<typeof createTestD1>, phone: string): Promise<string> {
  const drafts = createD1DraftStore(db);
  const draft = await drafts.createDraft({
    userPhone: phone,
    waMessageId: `wamid.${phone}.${Math.random()}`,
    imageUrls: [],
    flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
  });
  await drafts.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"));
  return draft!.id;
}

describe("AuditLogStore (D1)", () => {
  it("records edit/delete entries and lists them newest-first scoped to a business", async () => {
    const db = createTestD1();
    seedUser(db, PHONE, BIZ);
    const audit = createD1AuditLogStore(db);
    const txId = await makeLoggedTransaction(db, PHONE);

    await audit.record(BIZ, txId, "edit", { amount: { from: 100, to: 120 } });
    await audit.record(BIZ, txId, "delete", { vendor: { from: "Telstra", to: null } });

    const entries = await audit.listRecent(BIZ);
    expect(entries).toHaveLength(2);
    // Newest first.
    expect(entries[0]?.action).toBe("delete");
    expect(entries[0]?.changes).toEqual({ vendor: { from: "Telstra", to: null } });
    expect(entries[1]?.action).toBe("edit");
    expect(entries[1]?.changes).toEqual({ amount: { from: 100, to: 120 } });
    expect(entries[0]?.transactionId).toBe(txId);
    expect(entries[0]?.changedBy).toBe("dashboard-admin");
    expect(entries[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("scopes listRecent to the given business, not another business's entries", async () => {
    const db = createTestD1();
    seedUser(db, PHONE, BIZ);
    seedUser(db, "61499999999", BIZ2);
    const audit = createD1AuditLogStore(db);
    const tx1 = await makeLoggedTransaction(db, PHONE);
    const tx2 = await makeLoggedTransaction(db, "61499999999");

    await audit.record(BIZ, tx1, "edit", { amount: { from: 1, to: 2 } });
    await audit.record(BIZ2, tx2, "edit", { amount: { from: 3, to: 4 } });

    expect(await audit.listRecent(BIZ)).toHaveLength(1);
    expect(await audit.listRecent(BIZ2)).toHaveLength(1);
    expect((await audit.listRecent(BIZ))[0]?.transactionId).toBe(tx1);
  });

  it("respects the limit parameter", async () => {
    const db = createTestD1();
    seedUser(db, PHONE, BIZ);
    const audit = createD1AuditLogStore(db);
    const txId = await makeLoggedTransaction(db, PHONE);
    for (let i = 0; i < 5; i++) {
      await audit.record(BIZ, txId, "edit", { amount: { from: i, to: i + 1 } });
    }
    expect(await audit.listRecent(BIZ, 2)).toHaveLength(2);
  });
});
