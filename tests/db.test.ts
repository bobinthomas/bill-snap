import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createSupabaseBusinessStore } from "../src/db/businesses";
import { createSupabaseDraftStore, isDuplicateMatch, type DraftRecord } from "../src/db/drafts";
import { createSupabaseUserStore } from "../src/db/users";
import type { BillExtraction } from "../src/types";

const PHONE = "61412345678";
const BIZ = "11111111-1111-4111-8111-111111111111";

function supabaseConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  });
}

/** A fake PostgREST: records every request and serves scripted responses per route. */
class FakePostgrest {
  readonly requests: Array<{
    method: string;
    path: string;
    query: string;
    body?: unknown;
    prefer?: string;
  }> = [];

  private routes: Array<{
    method: string;
    path: string;
    fragments: string[];
    queue: Response[];
  }> = [];

  /** Serve one body for method+path whose query contains all fragments (undefined body → 204). */
  on(
    method: string,
    path: string,
    fragments: string[],
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): void {
    this.routes.push({
      method,
      path,
      fragments,
      queue: [
        new Response(body === undefined ? null : JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "Content-Type": "application/json", ...init.headers },
        }),
      ],
    });
  }

  /** Serve `bodies` in order (last one repeats) — for sequenced lookups on the same route. */
  onSequence(
    method: string,
    path: string,
    fragments: string[],
    bodies: unknown[],
    init: { status?: number; headers?: Record<string, string> } = {},
  ): void {
    this.routes.push({
      method,
      path,
      fragments,
      queue: bodies.map(
        (body) =>
          new Response(body === undefined ? null : JSON.stringify(body), {
            status: init.status ?? 200,
            headers: { "Content-Type": "application/json", ...init.headers },
          }),
      ),
    });
  }

  readonly handler: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.requests.push({
      method,
      path: url.pathname,
      query: decodeURIComponent(url.search.replace(/^\?/, "")),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      prefer: headers.Prefer,
    });

    const decodedSearch = decodeURIComponent(url.search);
    const route = this.routes.find(
      (r) =>
        r.method === method &&
        url.pathname.endsWith(r.path) &&
        r.fragments.every((f) => decodedSearch.includes(f)),
    );
    if (!route) {
      throw new Error(`FakePostgrest: no route for ${method} ${url.pathname}?${url.search}`);
    }
    const res = route.queue.length > 1 ? route.queue.shift()! : route.queue[0]!;
    return res.clone();
  };
}

const USER_ROW = {
  phone_number: PHONE,
  business_id: BIZ,
  setup_step: null,
  created_at: "2026-08-01T00:00:00.000Z",
};

const BUSINESS_ROW = {
  id: BIZ,
  name: "My Business",
  abn: null,
  timezone: "Australia/Sydney",
  gst_registered: true,
  auto_save: true,
  created_at: "2026-08-01T00:00:00.000Z",
};

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

function draftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "draft-1",
    user_phone: PHONE,
    wa_message_id: "wamid.1",
    flow_state: "awaiting_confirm",
    flow_expires_at: "2026-08-15T12:00:00.000Z",
    image_urls: ["MEDIA-1"],
    created_at: "2026-08-15T11:50:00.000Z",
    status: "draft",
    raw_extraction: null,
    gate_level: "high",
    machine_read: false,
    auto_logged: false,
    confirmed_at: null,
    flow_nudged_at: null,
    ...overrides,
  };
}

function expectQuery(req: { query: string }, fragment: string): void {
  expect(req.query).toContain(fragment);
}

describe("UserStore (REST)", () => {
  it("maps a users row and returns null when absent", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/users", ["phone_number=eq." + PHONE], [USER_ROW]);
    const store = createSupabaseUserStore(supabaseConfig(), fake.handler)!;

    const user = await store.findUser(PHONE);
    expect(user).toEqual({
      phoneNumber: PHONE,
      businessId: BIZ,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    fake.on("GET", "/rest/v1/users", ["phone_number=eq.61499999999"], []);
    const missing = await store.findUser("61499999999");
    expect(missing).toBeNull();
  });
});

describe("BusinessStore (REST)", () => {
  it("onboards: business → user → owner membership, idempotently", async () => {
    const fake = new FakePostgrest();
    // Sequence: first lookup (not onboarded) → [], second lookup (after inserts) → row.
    fake.onSequence("GET", "/rest/v1/users", ["phone_number=eq." + PHONE], [[], [USER_ROW]]);
    fake.on("POST", "/rest/v1/businesses", [], [BUSINESS_ROW]);
    fake.on("POST", "/rest/v1/users", [], undefined, { status: 204 });
    fake.on("POST", "/rest/v1/memberships", [], undefined, { status: 204 });

    const store = createSupabaseBusinessStore(supabaseConfig(), fake.handler)!;
    const onboarded = await store.onboard(PHONE);

    expect(onboarded.user.phoneNumber).toBe(PHONE);
    expect(onboarded.business).toMatchObject({ name: "My Business", timezone: "Australia/Sydney", gstRegistered: true, autoSave: true });

    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts.map((p) => p.path)).toEqual([
      "/rest/v1/businesses",
      "/rest/v1/users",
      "/rest/v1/memberships",
    ]);
    // Owner membership carries the role.
    const membership = posts[2]!;
    expect(membership.body).toEqual({ business_id: BIZ, user_phone: PHONE, role: "owner" });
    // Idempotent inserts.
    expect(posts[1]!.prefer).toContain("resolution=ignore-duplicates");
    expect(posts[2]!.prefer).toContain("resolution=ignore-duplicates");
  });

  it("onboard is a no-op for an already-onboarded user", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/users", ["phone_number=eq." + PHONE], [USER_ROW]);
    fake.on("GET", "/rest/v1/businesses", ["id=eq." + BIZ], [BUSINESS_ROW]);

    const store = createSupabaseBusinessStore(supabaseConfig(), fake.handler)!;
    const onboarded = await store.onboard(PHONE);

    expect(onboarded.business.id).toBe(BIZ);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("findBusiness and updateBusiness round-trip the row", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/businesses", ["id=eq." + BIZ], [BUSINESS_ROW]);
    fake.on(
      "PATCH",
      "/rest/v1/businesses",
      ["id=eq." + BIZ],
      [{ ...BUSINESS_ROW, name: "Café", timezone: "Australia/Melbourne", gst_registered: false }],
    );

    const store = createSupabaseBusinessStore(supabaseConfig(), fake.handler)!;
    expect((await store.findBusiness(BIZ))?.name).toBe("My Business");

    const updated = await store.updateBusiness(BIZ, { name: "Café", timezone: "Australia/Melbourne", gstRegistered: false });
    expect(updated).toMatchObject({ name: "Café", timezone: "Australia/Melbourne", gstRegistered: false });

    const patch = fake.requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ name: "Café", timezone: "Australia/Melbourne", gst_registered: false });
    expect(patch.prefer).toContain("return=representation");
  });

  it("setup step lives on users.setup_step", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/users", ["phone_number=eq." + PHONE], [{ ...USER_ROW, setup_step: "timezone" }]);
    fake.on("PATCH", "/rest/v1/users", ["phone_number=eq." + PHONE], undefined, { status: 204 });

    fake.on("GET", "/rest/v1/users", ["phone_number=eq.61499999999"], []);

    const store = createSupabaseBusinessStore(supabaseConfig(), fake.handler)!;
    expect(await store.getSetupStep(PHONE)).toBe("timezone");
    expect(await store.getSetupStep("61499999999")).toBeNull(); // no row → null

    await store.setSetupStep(PHONE, null);
    const patch = fake.requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ setup_step: null });
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
    // Mirrors findDuplicate's SQL: the vendor+amount branch fires independently
    // of the invoice branch — the same recurring charge double-logged with a
    // new invoice number is still a duplicate.
    expect(isDuplicateMatch(prev, { invoiceNumber: "INV-2", vendor: "Telstra", amount: 245 })).toBe(true);
  });

  it("never matches a candidate missing vendor or amount", () => {
    expect(isDuplicateMatch(prev, { invoiceNumber: null, vendor: null, amount: 245 })).toBe(false);
    expect(isDuplicateMatch(prev, { invoiceNumber: null, vendor: "Telstra", amount: null })).toBe(false);
  });
});

describe("DraftStore (REST)", () => {
  function makeStore(fake: FakePostgrest) {
    return createSupabaseDraftStore(supabaseConfig(), fake.handler)!;
  }

  it("createDraft inserts a processing draft and maps the row", async () => {
    const fake = new FakePostgrest();
    fake.on("POST", "/rest/v1/transactions", [], [draftRow({ flow_state: "processing" })]);
    const store = makeStore(fake);

    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: ["MEDIA-1"],
      flowExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(draft?.id).toBe("draft-1");
    expect(draft?.flowState).toBe("processing");
    expect(draft?.status).toBe("draft");
    expect(draft?.imageUrls).toEqual(["MEDIA-1"]);
    expect(draft?.flowExpiresAt).toEqual(new Date("2026-08-15T12:00:00.000Z"));

    const post = fake.requests[0]!;
    expect(post.prefer).toContain("return=representation");
    expect(post.prefer).toContain("resolution=ignore-duplicates");
    expect(post.body).toEqual({
      user_phone: PHONE,
      wa_message_id: "wamid.1",
      image_urls: ["MEDIA-1"],
      flow_state: "processing",
      flow_expires_at: "2026-08-15T12:00:00.000Z",
      status: "draft",
    });
  });

  it("createDraft returns null on a retried delivery (idempotency)", async () => {
    const fake = new FakePostgrest();
    fake.on("POST", "/rest/v1/transactions", [], []);
    const store = makeStore(fake);
    const draft = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.1",
      imageUrls: [],
      flowExpiresAt: new Date(),
    });
    expect(draft).toBeNull();
  });

  it("findActiveDraft filters to the user's live draft", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/transactions", ["status=eq.draft", "order=created_at.desc", "limit=1"], [draftRow()]);
    const store = makeStore(fake);

    const draft = await store.findActiveDraft(PHONE, new Date("2026-08-15T11:55:00.000Z"));
    expect(draft?.gateLevel).toBe("high");
    expect(draft?.machineRead).toBe(false);

    const req = fake.requests[0]!;
    expectQuery(req, "user_phone=eq." + PHONE);
    expectQuery(req, "status=eq.draft");
    expectQuery(req, "flow_expires_at=gt.2026-08-15T11:55:00.000Z");
  });

  it("setFlowState persists the extraction and gating", async () => {
    const fake = new FakePostgrest();
    // PostgREST returns the updated row — including the extraction just written.
    fake.on(
      "PATCH",
      "/rest/v1/transactions",
      ["id=eq.draft-1"],
      [draftRow({ raw_extraction: EXTRACTION })],
    );
    const store = makeStore(fake);

    const updated = await store.setFlowState("draft-1", {
      flowState: "awaiting_confirm",
      extraction: EXTRACTION,
      gateLevel: "high",
      machineRead: false,
      imageUrls: ["https://project.supabase.co/storage/v1/object/public/bills/biz-1/2026/08/MEDIA-1.jpg"],
    });

    expect(updated?.extraction).toEqual(EXTRACTION);
    const patch = fake.requests[0]!;
    expect(patch.body).toEqual({
      flow_state: "awaiting_confirm",
      raw_extraction: EXTRACTION,
      gate_level: "high",
      machine_read: false,
      image_urls: ["https://project.supabase.co/storage/v1/object/public/bills/biz-1/2026/08/MEDIA-1.jpg"],
    });
  });

  it("confirm denormalises the extraction onto the logged row", async () => {
    const fake = new FakePostgrest();
    fake.on(
      "GET",
      "/rest/v1/transactions",
      ["id=eq.draft-1"],
      [draftRow({ raw_extraction: EXTRACTION })],
    );
    fake.on(
      "PATCH",
      "/rest/v1/transactions",
      ["id=eq.draft-1"],
      [draftRow({ status: "logged", flow_state: null, auto_logged: true, confirmed_at: "2026-08-15T12:01:00.000Z", raw_extraction: EXTRACTION })],
    );
    const store = makeStore(fake);

    const logged = await store.confirm("draft-1", new Date("2026-08-15T12:01:00.000Z"), { autoLogged: true });
    expect(logged?.status).toBe("logged");
    expect(logged?.flowState).toBeNull();
    expect(logged?.autoLogged).toBe(true);

    const patch = fake.requests[1]!;
    expect(patch.body).toMatchObject({
      status: "logged",
      flow_state: null,
      confirmed_at: "2026-08-15T12:01:00.000Z",
      auto_logged: true,
      amount: 245,
      gst: 22.27,
      category: "utilities",
      vendor: "Telstra",
      invoice_number: "INV-1",
      due_date: "2026-09-05",
    });
  });

  it("confirm returns null when the draft is already gone", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/transactions", ["id=eq.draft-1"], []);
    const store = makeStore(fake);
    expect(await store.confirm("draft-1", new Date())).toBeNull();
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("expire and softDeleteLogged flip status", async () => {
    const fake = new FakePostgrest();
    fake.on("PATCH", "/rest/v1/transactions", ["id=eq.draft-1"], undefined, { status: 204 });
    fake.on("PATCH", "/rest/v1/transactions", ["id=eq.draft-1"], undefined, { status: 204 });
    const store = makeStore(fake);

    await store.expire("draft-1");
    await store.softDeleteLogged("draft-1");

    const patches = fake.requests;
    expect(patches[0]!.body).toEqual({ status: "expired", flow_state: null });
    expect(patches[1]!.body).toEqual({ status: "deleted" });
  });

  it("findRecentLogged scopes the undo lookup", async () => {
    const fake = new FakePostgrest();
    fake.on(
      "GET",
      "/rest/v1/transactions",
      ["status=in.(logged,paid)", "order=confirmed_at.desc", "limit=1"],
      [draftRow({ status: "logged", confirmed_at: "2026-08-15T12:01:00.000Z" })],
    );
    const store = makeStore(fake);

    const recent = await store.findRecentLogged(PHONE, new Date("2026-08-15T11:00:00.000Z"));
    expect(recent?.status).toBe("logged");
    const req = fake.requests[0]!;
    expectQuery(req, "confirmed_at=gte.2026-08-15T11:00:00.000Z");
  });

  it("listLogged returns the newest logged rows for the dashboard", async () => {
    const fake = new FakePostgrest();
    fake.on(
      "GET",
      "/rest/v1/transactions",
      ["order=confirmed_at.desc", "limit=100"],
      [draftRow({ status: "logged", confirmed_at: "2026-08-15T12:01:00.000Z" })],
    );
    const store = makeStore(fake);

    const logged = await store.listLogged(PHONE);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.status).toBe("logged");
    const req = fake.requests[0]!;
    expectQuery(req, "user_phone=eq." + PHONE);
    expectQuery(req, "status=in.(logged,paid)");
    expectQuery(req, "order=confirmed_at.desc");
    expectQuery(req, "limit=100");
  });

  it("findDuplicate checks invoice_number first, then vendor + amount", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/transactions", ["invoice_number=eq.INV-1"], [draftRow({ status: "logged" })]);
    const store = makeStore(fake);

    const dup = await store.findDuplicate(PHONE, EXTRACTION, new Date("2026-08-15T00:00:00.000Z"));
    expect(dup?.status).toBe("logged");
    const req = fake.requests[0]!;
    expectQuery(req, "invoice_number=eq.INV-1");
    expectQuery(req, "status=in.(logged,paid)");

    // No invoice → vendor+amount fallback.
    const fake2 = new FakePostgrest();
    fake2.on("GET", "/rest/v1/transactions", ["vendor=eq.Telstra", "amount=eq.245"], []);
    const store2 = makeStore(fake2);
    const noInv: BillExtraction = { ...EXTRACTION, invoice_number: { value: null, confidence: 0 } };
    expect(await store2.findDuplicate(PHONE, noInv, new Date("2026-08-15T00:00:00.000Z"))).toBeNull();
    expectQuery(fake2.requests[0]!, "vendor=eq.Telstra");
    expectQuery(fake2.requests[0]!, "amount=eq.245");
  });

  it("findNudgeDue sends the range as one and=(...) expression", async () => {
    const fake = new FakePostgrest();
    fake.on("GET", "/rest/v1/transactions", ["flow_nudged_at=is.null"], [draftRow(), draftRow({ id: "draft-2" })]);
    const store = makeStore(fake);

    const due = await store.findNudgeDue(new Date("2026-08-15T12:00:00.000Z"), 240_000);
    expect(due).toHaveLength(2);

    const req = fake.requests[0]!;
    expectQuery(req, "and=(flow_expires_at.gt.2026-08-15T12:00:00.000Z,flow_expires_at.lte.2026-08-15T12:04:00.000Z)");
    expectQuery(req, "flow_state=in.(awaiting_confirm,editing_amount,editing_vendor,editing_date)");
  });

  it("markNudged stamps flow_nudged_at", async () => {
    const fake = new FakePostgrest();
    fake.on("PATCH", "/rest/v1/transactions", ["id=eq.draft-1"], undefined, { status: 204 });
    const store = makeStore(fake);
    await store.markNudged("draft-1", new Date("2026-08-15T12:06:00.000Z"));
    expect(fake.requests[0]!.body).toEqual({ flow_nudged_at: "2026-08-15T12:06:00.000Z" });
  });

  it("expireDue returns the count from Content-Range", async () => {
    const fake = new FakePostgrest();
    fake.on("PATCH", "/rest/v1/transactions", ["status=eq.draft", "flow_expires_at=lte.2026-08-15T12:00:00.000Z"], undefined, {
      status: 204,
      headers: { "Content-Range": "*/3" },
    });
    const store = makeStore(fake);

    const count = await store.expireDue(new Date("2026-08-15T12:00:00.000Z"));
    expect(count).toBe(3);

    const req = fake.requests[0]!;
    expect(req.prefer).toContain("count=exact");
    expect(req.body).toEqual({ status: "expired", flow_state: null });
  });

  it("surfaces a PostgREST error with its code", async () => {
    const fake = new FakePostgrest();
    fake.on(
      "POST",
      "/rest/v1/transactions",
      [],
      { message: 'duplicate key value violates unique constraint "transactions_draft_idempotency"', code: "23505" },
      { status: 409 },
    );
    const store = makeStore(fake);
    await expect(
      store.createDraft({ userPhone: PHONE, waMessageId: "wamid.1", imageUrls: [], flowExpiresAt: new Date() }),
    ).rejects.toMatchObject({ name: "SupabaseRestError", code: "23505", status: 409 });
  });
});
