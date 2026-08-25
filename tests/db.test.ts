import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createD1BusinessStore } from "../src/db/businesses";
import { createD1DraftStore, isDuplicateMatch, type DraftRecord } from "../src/db/drafts";
import { createD1TransactionStore } from "../src/db/transactions";
import { createD1UserStore } from "../src/db/users";
import type { BillExtraction } from "../src/types";
import { createTestD1 } from "./fakes";

const PHONE = "61412345678";
const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE2 = "61412345679";
const BIZ2 = "22222222-2222-4222-8222-222222222222";

const EXTRACTION: BillExtraction = {
  amount: { value: 245, confidence: 0.98 },
  date: { value: "2026-08-15", confidence: 0.95 },
  vendor: { value: "Telstra", confidence: 0.9 },
  abn: { value: "51 824 753 556", confidence: 0.9 },
  gst: { value: 22.27, confidence: 0.9 },
  gst_basis: "inclusive",
  invoice_number: { value: "INV-1", confidence: 0.9 },
  due_date: { value: "2026-09-05", confidence: 0.9 },
  category_hint: { value: "utilities", confidence: 0.9 },
};

/** Seed a business + user so drafts (which reference users) can be created. */
function seedUser(db: ReturnType<typeof createTestD1>, phone = PHONE, businessId = BIZ): void {
  db.prepare("insert or ignore into businesses (id, name, timezone) values (?, ?, ?)")
    .bind(businessId, "My Business", "Australia/Sydney")
    .run();
  db.prepare("insert or ignore into users (phone_number, business_id) values (?, ?)").bind(phone, businessId).run();
}

describe("UserStore (D1)", () => {
  it("maps a users row and returns null when absent", async () => {
    const db = createTestD1();
    seedUser(db);
    const store = createD1UserStore(db);

    const user = await store.findUser(PHONE);
    expect(user).toEqual({
      phoneNumber: PHONE,
      businessId: BIZ,
      createdAt: expect.any(Date),
    });

    expect(await store.findUser("61499999999")).toBeNull();
  });
});

describe("BusinessStore (D1)", () => {
  it("onboards: business → user → owner membership, idempotently", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);

    const onboarded = await store.onboard(PHONE);
    expect(onboarded.user.phoneNumber).toBe(PHONE);
    expect(onboarded.business).toMatchObject({
      name: "My Business",
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
    });

    // Business + user + owner membership rows all exist.
    const business = await store.findBusiness(onboarded.business.id);
    expect(business?.id).toBe(onboarded.business.id);
    const membership = await db
      .prepare("select role from memberships where business_id = ? and user_phone = ?")
      .bind(onboarded.business.id, PHONE)
      .first<{ role: string }>();
    expect(membership?.role).toBe("owner");

    // Idempotent: a second onboard returns the same business, no new rows.
    const again = await store.onboard(PHONE);
    expect(again.business.id).toBe(onboarded.business.id);
    const count = await db.prepare("select count(*) as n from businesses").first<{ n: number }>();
    expect(Number(count?.n)).toBe(1);
  });

  it("onboard is a no-op for an already-onboarded user", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);
    const first = await store.onboard(PHONE);

    const again = await store.onboard(PHONE);
    expect(again.business.id).toBe(first.business.id);
    const memberships = await db.prepare("select count(*) as n from memberships").first<{ n: number }>();
    expect(Number(memberships?.n)).toBe(1);
  });

  it("findBusiness and updateBusiness round-trip the row", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);
    const onboarded = await store.onboard(PHONE);
    expect(onboarded.business.name).toBe("My Business");

    const updated = await store.updateBusiness(onboarded.business.id, {
      name: "Café",
      timezone: "Australia/Melbourne",
      gstRegistered: false,
    });
    expect(updated).toMatchObject({ name: "Café", timezone: "Australia/Melbourne", gstRegistered: false });
    expect((await store.findBusiness(onboarded.business.id))?.name).toBe("Café");
  });

  it("updateBusiness patches the company-profile fields (abn/gstNumber/address/phone)", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);
    const onboarded = await store.onboard(PHONE);
    expect(onboarded.business).toMatchObject({ abn: null, gstNumber: null, address: null, phone: null });

    const updated = await store.updateBusiness(onboarded.business.id, {
      abn: "51 824 753 556",
      gstNumber: "GST-12345",
      address: "1 Example St, Sydney NSW 2000",
      phone: "+61 2 9000 0000",
    });
    expect(updated).toMatchObject({
      abn: "51 824 753 556",
      gstNumber: "GST-12345",
      address: "1 Example St, Sydney NSW 2000",
      phone: "+61 2 9000 0000",
    });
    expect(await store.findBusiness(onboarded.business.id)).toMatchObject(updated);
  });

  it("listMembers returns the owner membership from onboard, newest last", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);
    const onboarded = await store.onboard(PHONE);

    const members = await store.listMembers(onboarded.business.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userPhone: PHONE, role: "owner" });
  });

  it("setup step lives on users.setup_step", async () => {
    const db = createTestD1();
    const store = createD1BusinessStore(db);
    await store.onboard(PHONE);

    expect(await store.getSetupStep(PHONE)).toBeNull();
    await store.setSetupStep(PHONE, "timezone");
    expect(await store.getSetupStep(PHONE)).toBe("timezone");
    await store.setSetupStep(PHONE, null);
    expect(await store.getSetupStep(PHONE)).toBeNull();
    expect(await store.getSetupStep("61499999999")).toBeNull();
  });
});

describe("isDuplicateMatch (§5.8 predicate)", () => {
  const prev = { invoiceNumber: "INV-1", vendor: "Telstra", amount: 245 };

  it("matches on an equal invoice number regardless of other fields", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: "INV-1", vendor: "Optus", amount: 99 })).toBe(true);
  });

  it("matches on equal vendor + amount when the candidate has no invoice", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: null, vendor: "Telstra", amount: 245 })).toBe(true);
  });

  it("does not match near-duplicates: distinct invoice AND distinct amount", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: "INV-2", vendor: "Telstra", amount: 244.9 })).toBe(false);
  });

  it("matches on equal vendor + amount even when invoices differ (both branches run)", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: "INV-2", vendor: "Telstra", amount: 245 })).toBe(true);
  });

  it("never matches a candidate missing vendor or amount", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: null, vendor: null, amount: 245 })).toBe(false);
    expect(isDuplicateMatch(prev, { invoiceNumber: null, vendor: "Telstra", amount: null })).toBe(false);
  });
});

describe("DraftStore (D1)", () => {
  function makeStore() {
    const db = createTestD1();
    seedUser(db);
    const store = createD1DraftStore(db);
    return { db, store };
  }

  it("createDraft inserts a processing draft and maps the row", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: ["MEDIA-1"],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(draft).not.toBeNull();
    expect(draft?.flowState).toBe("processing");
    expect(draft?.status).toBe("draft");
    expect(draft?.imageUrls).toEqual(["MEDIA-1"]);
    expect(draft?.flowExpiresAt).toEqual(new Date("2026-08-15T12:00:00.000Z"));
  });

  it("createDraft returns null on a retried delivery (idempotency)", async () => {
    const { store } = makeStore();
    const input = {
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: ["MEDIA-1"],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    };
    expect((await store.createDraft(input))?.id).toBeDefined();
    expect(await store.createDraft(input)).toBeNull();
  });

  it("createDraft idempotency releases once the draft is logged", async () => {
    const { store } = makeStore();
    const input = {
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    };
    const draft = await store.createDraft(input);
    expect(draft).not.toBeNull();
    await store.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"), { autoLogged: true });
    // Same wa_message_id on a NEW draft is allowed once the old one is logged.
    expect((await store.createDraft(input))?.id).toBeDefined();
  });

  it("findActiveDraft filters to the user's live draft", async () => {
    const { store } = makeStore();
    await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState((await store.findActiveDraft(PHONE, new Date("2026-08-15T11:55:00.000Z")))!.id, {
      flowState: "awaiting_confirm",
      extraction: EXTRACTION,
      gateLevel: "high",
      machineRead: false,
    });

    const draft = await store.findActiveDraft(PHONE, new Date("2026-08-15T11:55:00.000Z"));
    expect(draft?.gateLevel).toBe("high");
    expect(draft?.machineRead).toBe(false);

    // Expired drafts are not returned.
    expect(await store.findActiveDraft(PHONE, new Date("2026-08-15T13:00:00.000Z"))).toBeNull();
  });

  it("setFlowState persists the extraction and gating", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });

    const updated = await store.setFlowState(draft!.id, {
      flowState: "awaiting_confirm",
      extraction: EXTRACTION,
      gateLevel: "high",
      machineRead: false,
      imageUrls: ["/bills/biz-1/2026/08/MEDIA-1.jpg"],
    });

    expect(updated?.extraction).toEqual(EXTRACTION);
    expect(updated?.gateLevel).toBe("high");
    expect(updated?.imageUrls).toEqual(["/bills/biz-1/2026/08/MEDIA-1.jpg"]);
  });

  it("setFlowState persists business_id onto the transaction row", async () => {
    const { db, store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    // Not set at createDraft time — the tenant key is only known once the
    // business is resolved (photo.ts, after resolveBusiness).
    expect(
      (await db.prepare("select business_id from transactions where id = ?").bind(draft!.id).first<{
        business_id: string | null;
      }>())?.business_id,
    ).toBeNull();

    await store.setFlowState(draft!.id, { flowState: "awaiting_confirm", businessId: BIZ });

    const row = await db
      .prepare("select business_id from transactions where id = ?")
      .bind(draft!.id)
      .first<{ business_id: string | null }>();
    expect(row?.business_id).toBe(BIZ);
  });

  it("setFlowState accepts editing_category (flow_state CHECK constraint, migration 0002)", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    // Regression: 0001_schema.sql's flow_state CHECK omitted 'editing_category'
    // even though it's a reachable FlowState (confirm option 6) — this threw a
    // CHECK constraint error against real D1 before migration 0002 fixed it.
    const updated = await store.setFlowState(draft!.id, { flowState: "editing_category" });
    expect(updated.flowState).toBe("editing_category");
  });

  it("confirm denormalises the extraction onto the logged row", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft!.id, {
      flowState: "awaiting_confirm",
      extraction: EXTRACTION,
      gateLevel: "high",
      machineRead: false,
    });

    const logged = await store.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"), { autoLogged: true });
    expect(logged?.status).toBe("logged");
    expect(logged?.flowState).toBeNull();
    expect(logged?.autoLogged).toBe(true);
    expect(logged?.confirmedAt).toEqual(new Date("2026-08-15T12:01:00.000Z"));
  });

  it("confirm returns null when the draft is already gone", async () => {
    const { store } = makeStore();
    expect(await store.confirm("draft-nope", new Date())).toBeNull();
  });

  it("expire and softDeleteLogged flip status", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft!.id, { flowState: "awaiting_confirm" });

    await store.expire(draft!.id);
    expect((await store.findActiveDraft(PHONE))).toBeNull();

    // A logged draft can be soft-deleted (undo path, §5.6).
    const draft2 = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.2",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft2!.id, { flowState: "awaiting_confirm" });
    await store.confirm(draft2!.id, new Date("2026-08-15T12:01:00.000Z"));
    await store.softDeleteLogged(draft2!.id);
    expect(await store.findRecentLogged(PHONE, new Date(Date.now() - 60_000))).toBeNull();
  });

  it("findRecentLogged scopes the undo lookup", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft!.id, { flowState: "awaiting_confirm" });
    await store.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"));

    const recent = await store.findRecentLogged(PHONE, new Date("2026-08-15T11:00:00.000Z"));
    expect(recent?.status).toBe("logged");
    // A window after the confirm finds nothing.
    expect(await store.findRecentLogged(PHONE, new Date("2026-08-15T13:00:00.000Z"))).toBeNull();
  });

  it("listLogged returns the newest logged rows for the dashboard", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft!.id, { flowState: "awaiting_confirm" });
    await store.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"));

    const logged = await store.listLogged(PHONE);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.status).toBe("logged");
    expect(logged[0]?.confirmedAt).toEqual(new Date("2026-08-15T12:01:00.000Z"));
  });

  it("findDuplicate checks invoice_number first, then vendor + amount", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await store.setFlowState(draft!.id, {
      flowState: "awaiting_confirm",
      extraction: EXTRACTION,
      gateLevel: "high",
      machineRead: false,
    });
    await store.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"), { autoLogged: true });

    const dup = await store.findDuplicate(PHONE, EXTRACTION, new Date("2026-08-15T00:00:00.000Z"));
    expect(dup?.status).toBe("logged");

    // No invoice → vendor+amount fallback matches the same row.
    const noInv: BillExtraction = { ...EXTRACTION, invoice_number: { value: null, confidence: 0 } };
    const dup2 = await store.findDuplicate(PHONE, noInv, new Date("2026-08-15T00:00:00.000Z"));
    expect(dup2?.id).toBe(draft!.id);

    // A different amount is not a duplicate.
    const diff: BillExtraction = { ...noInv, amount: { value: 999, confidence: 0.98 } };
    expect(await store.findDuplicate(PHONE, diff, new Date("2026-08-15T00:00:00.000Z"))).toBeNull();
  });

  it("findNudgeDue returns never-nudged drafts inside the window", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:04:00.000Z"), // expires within the window
    });
    await store.setFlowState(draft!.id, { flowState: "awaiting_confirm" });

    const due = await store.findNudgeDue(new Date("2026-08-15T12:00:00.000Z"), 240_000);
    expect(due).toHaveLength(1);
    expect(due[0]?.id).toBe(draft!.id);

    // After nudging, not due again (one-nudge cap).
    await store.markNudged(draft!.id, new Date("2026-08-15T12:06:00.000Z"));
    expect(await store.findNudgeDue(new Date("2026-08-15T12:00:00.000Z"), 240_000)).toHaveLength(0);
  });

  it("markNudged stamps flow_nudged_at", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:04:00.000Z"),
    });
    await store.markNudged(draft!.id, new Date("2026-08-15T12:06:00.000Z"));
    const due = await store.findNudgeDue(new Date("2026-08-15T12:00:00.000Z"), 240_000);
    expect(due).toHaveLength(0);
  });

  it("expireDue flips expired drafts and returns the count", async () => {
    const { store } = makeStore();
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T11:50:00.000Z"), // already past 12:00
    });
    await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.2",
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T13:00:00.000Z"), // still live
    });

    const count = await store.expireDue(new Date("2026-08-15T12:00:00.000Z"));
    expect(count).toBe(1);
    // The live draft remains active; the expired one is gone.
    const active = await store.findActiveDraft(PHONE, new Date("2026-08-15T12:30:00.000Z"));
    expect(active).not.toBeNull();
    expect(active?.id).not.toBe(draft!.id);
  });
});

describe("TransactionStore (D1) — vendor->category episodic memory", () => {
  /** Logs one confirmed bill for (phone, businessId) with the given vendor/category. */
  async function logBill(
    db: ReturnType<typeof createTestD1>,
    phone: string,
    businessId: string,
    vendor: string,
    category: string,
    waMessageId: string,
  ): Promise<void> {
    const drafts = createD1DraftStore(db);
    const draft = await drafts.createDraft({
      userPhone: phone,
      waMessageId,
      imageUrls: [],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });
    await drafts.setFlowState(draft!.id, {
      flowState: "awaiting_confirm",
      extraction: {
        ...EXTRACTION,
        vendor: { value: vendor, confidence: 1 },
        category_hint: { value: category, confidence: 1 },
      },
      gateLevel: "high",
      machineRead: false,
      businessId,
    });
    await drafts.confirm(draft!.id, new Date("2026-08-15T12:01:00.000Z"));
  }

  it("returns the majority category once a vendor clears the sample-size and share thresholds", async () => {
    const db = createTestD1();
    seedUser(db);
    await logBill(db, PHONE, BIZ, "Telstra", "utilities", "wamid.1");
    await logBill(db, PHONE, BIZ, "Telstra", "utilities", "wamid.2");
    await logBill(db, PHONE, BIZ, "Telstra", "utilities", "wamid.3");
    await logBill(db, PHONE, BIZ, "telstra", "misc", "wamid.4"); // one dissenting vote (75% share), case-varied

    const history = await createD1TransactionStore(db).getVendorCategoryHistory(BIZ);
    expect(history.get("TELSTRA")).toMatchObject({ category: "utilities", sampleSize: 4 });
  });

  it("drops a vendor whose history is one-off or too evenly split to trust", async () => {
    const db = createTestD1();
    seedUser(db);
    await logBill(db, PHONE, BIZ, "Bunnings", "inventory", "wamid.1"); // sample size 1 — not enough

    const history = await createD1TransactionStore(db).getVendorCategoryHistory(BIZ);
    expect(history.has("BUNNINGS")).toBe(false);
  });

  it("scopes history to one business — no cross-tenant leakage", async () => {
    const db = createTestD1();
    seedUser(db, PHONE, BIZ);
    seedUser(db, PHONE2, BIZ2);
    await logBill(db, PHONE, BIZ, "Bunnings", "inventory", "wamid.1");
    await logBill(db, PHONE, BIZ, "Bunnings", "inventory", "wamid.2");
    await logBill(db, PHONE2, BIZ2, "Bunnings", "wages", "wamid.3");
    await logBill(db, PHONE2, BIZ2, "Bunnings", "wages", "wamid.4");

    const store = createD1TransactionStore(db);
    expect((await store.getVendorCategoryHistory(BIZ)).get("BUNNINGS")).toMatchObject({ category: "inventory" });
    expect((await store.getVendorCategoryHistory(BIZ2)).get("BUNNINGS")).toMatchObject({ category: "wages" });
  });
});
