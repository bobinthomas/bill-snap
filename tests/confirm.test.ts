import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { DraftRecord, DraftStore } from "../src/db/drafts";
import { classify } from "../src/extraction/gate";
import { handleDraftReply } from "../src/flows/confirm";
import { handleCommand } from "../src/flows/commands";
import {
  AUTOSAVE_OFF_TEXT,
  AUTOSAVE_ON_TEXT,
  EDIT_AMOUNT_PROMPT,
  EDIT_CANCELLED_TEXT,
  EDIT_CATEGORY_PROMPT,
  EDIT_DATE_PROMPT,
  EDIT_VENDOR_PROMPT,
  HELP_TEXT,
  SKIPPED_TEXT,
  UNDONE_TEXT,
  UNDO_NOTHING_TEXT,
  UNDO_WINDOW_TEXT,
  formatAUD,
  renderConfirmScreen,
} from "../src/messaging/screens";
import { createMockMessenger, type MockMessenger } from "../src/messaging/mock";
import type { InboundEvent } from "../src/types";
import type { BillExtraction } from "../src/types";
import type { RouteDeps } from "../src/webhook/router";
import { FakeBillStorage, FakeBusinessStore, FakeDraftStore, FakeUserStore } from "./fakes";

const PHONE = "61412345678";
const CONFIG = loadConfig({});

function extraction(overrides: Partial<BillExtraction> = {}): BillExtraction {
  return {
    amount: { value: 245.0, confidence: 0.97 },
    date: { value: "2026-08-10", confidence: 0.99 },
    vendor: { value: "Telstra", confidence: 0.95 },
    abn: { value: "51 824 753 556", confidence: 0.9 },
    gst: { value: 22.27, confidence: 0.92 },
    gst_basis: "inclusive",
    invoice_number: { value: "INV-2847", confidence: 0.88 },
    due_date: { value: null, confidence: 0 },
    category_hint: { value: "utilities", confidence: 0.6 },
    ...overrides,
  };
}

function textEvent(text: string): InboundEvent {
  return {
    userPhone: PHONE,
    waMessageId: "wamid." + Math.random().toString(36).slice(2),
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "text",
    text,
  };
}

async function makeDraft(
  store: DraftStore,
  ext: BillExtraction,
  opts: { machineRead?: boolean; gate?: "high" | "partial" | "low" } = {},
): Promise<DraftRecord> {
  const created = await store.createDraft({
    userPhone: PHONE,
    waMessageId: "wamid." + Math.random().toString(36).slice(2),
    imageUrls: ["MEDIA-1"],
    flowExpiresAt: new Date(Date.now() + 600_000),
  });
  if (!created) throw new Error("draft not created");
  return store.setFlowState(created.id, {
    flowState: "awaiting_confirm",
    extraction: ext,
    gateLevel: opts.gate ?? classify(ext, CONFIG.extraction),
    machineRead: opts.machineRead ?? false,
  });
}

function makeDeps(): {
  store: FakeDraftStore;
  send: MockMessenger;
  businesses: FakeBusinessStore;
  deps: RouteDeps;
} {
  const store = new FakeDraftStore();
  const send = createMockMessenger();
  const users = new FakeUserStore([{ phoneNumber: PHONE, businessId: "biz-1", createdAt: new Date() }]);
  const businesses = new FakeBusinessStore(users);
  const deps: RouteDeps = {
    users,
    businesses,
    drafts: store,
    extraction: { run: async () => ({ extraction: extraction(), gate: "high", machineRead: false, source: "ai" }) },
    send,
    storage: new FakeBillStorage(),
    config: CONFIG,
  };
  return { store, send, businesses, deps };
}

describe("renderConfirmScreen (§6.2 variants)", () => {
  it("renders Variant A for high confidence, non-machine-read", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction());
    const screen = renderConfirmScreen(draft, CONFIG);
    expect(screen).toContain("✅ High confidence");
    expect(screen).toContain(`Amount: ${formatAUD(245)}`);
    expect(screen).toContain("Category: utilities");
    expect(screen).toContain("ABN: 51 824 753 556");
    expect(screen).not.toContain("5️⃣ Edit date");
    expect(screen).toContain("6️⃣ Edit category");
    expect(screen).toContain("4️⃣ Skip / Wrong bill");
  });

  it("renders Variant B flags for a partial extraction", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction({ vendor: { value: null, confidence: 0 } }));
    const screen = renderConfirmScreen(draft, CONFIG);
    expect(screen).toContain("⚠️ Check details");
    expect(screen).toContain("Vendor: Not found — edit to add");
  });

  it("renders Variant C for machine-read extractions", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction({ date: { value: null, confidence: 0 } }), {
      machineRead: true,
    });
    const screen = renderConfirmScreen(draft, CONFIG);
    expect(screen).toContain("Machine-read, please verify");
    expect(screen).toContain("Date: Not found — edit to add");
    expect(screen).toContain("5️⃣ Edit date");
  });

  it("shows verify flags for low-confidence fields and GST — when null", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(
      store,
      extraction({ date: { value: "2026-08-10", confidence: 0.5 }, gst: { value: null, confidence: 0 } }),
    );
    const screen = renderConfirmScreen(draft, CONFIG);
    expect(screen).toContain("Date: 2026-08-10 ⚠️ verify");
    expect(screen).toContain("GST: —");
    expect(screen).toContain("5️⃣ Edit date");
  });

  it("shows ABN as not verified when absent", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction({ abn: { value: null, confidence: 0 } }));
    expect(renderConfirmScreen(draft, CONFIG)).toContain("ABN: Not verified");
  });

  it("shows category as missing when absent", async () => {
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction({ category_hint: { value: null, confidence: 0 } }));
    expect(renderConfirmScreen(draft, CONFIG)).toContain("Category: Not found — edit to add");
  });
});

describe("handleDraftReply options (§6.2)", () => {
  it("1 → confirms and logs the draft", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("1"), draft, deps);
    expect(send.sent[0]?.text).toContain("✅ Logged:");
    expect(send.sent[0]?.text).toContain("within 5 minutes to undo");
    expect(await store.findActiveDraft(PHONE)).toBeNull();
  });

  it("2/3/5/6 → enters the edit sub-flows", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction({ date: { value: null, confidence: 0 } }));
    await handleDraftReply(textEvent("2"), draft, deps);
    expect(send.sent[0]?.text).toBe(EDIT_AMOUNT_PROMPT);

    const draft2 = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("3"), draft2, deps);
    expect(send.sent[1]?.text).toBe(EDIT_VENDOR_PROMPT);

    const draft3 = await makeDraft(store, extraction({ date: { value: null, confidence: 0 } }));
    await handleDraftReply(textEvent("5"), draft3, deps);
    expect(send.sent[2]?.text).toBe(EDIT_DATE_PROMPT);

    const draft4 = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("6"), draft4, deps);
    expect(send.sent[3]?.text).toBe(EDIT_CATEGORY_PROMPT);
  });

  it("4 → skips and expires the draft", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("4"), draft, deps);
    expect(send.sent[0]?.text).toBe(SKIPPED_TEXT);
    expect(await store.findActiveDraft(PHONE)).toBeNull();
  });

  it("help → help text, draft stays active", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("help"), draft, deps);
    expect(send.sent[0]?.text).toBe(HELP_TEXT);
    expect(await store.findActiveDraft(PHONE)).not.toBeNull();
  });

  it("unknown reply → options hint", async () => {
    const { send, deps } = makeDeps();
    const { store } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("banana"), draft, deps);
    expect(send.sent[0]?.text).toContain("Reply `1` to confirm");
  });

  it("`setup` starts the wizard without expiring the draft", async () => {
    const { store, send, businesses, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("setup"), draft, deps);
    expect(await businesses.getSetupStep(PHONE)).toBe("name");
    expect(send.sent[0]?.text).toContain("Setup — Business name");
    // The bill stays pending — the wizard replies, not this branch, follow.
    expect(await store.findActiveDraft(PHONE)).not.toBeNull();
  });
});

describe("edit sub-flows (§6.3)", () => {
  it("edits the amount, recomputes GST, and re-renders", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("2"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("300"), editing!, deps);

    expect(send.sent[1]?.text).toContain("✅ Amount updated — $300.00");
    expect(send.sent[1]?.text).toContain("📄 Bill Read");
    const updated = await store.findActiveDraft(PHONE);
    expect(updated?.extraction?.amount.value).toBe(300);
    expect(updated?.extraction?.gst.value).toBeCloseTo(300 / 11);
    expect(updated?.flowState).toBe("awaiting_confirm");
  });

  it("re-prompts on an invalid amount and stays in the sub-flow", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("2"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("abc"), editing!, deps);

    expect(send.sent[1]?.text).toContain("doesn't look like an amount");
    expect((await store.findActiveDraft(PHONE))?.flowState).toBe("editing_amount");
  });

  it("edits the vendor", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("3"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("Telstra Pty Ltd"), editing!, deps);

    expect(send.sent[1]?.text).toContain("✅ Vendor updated — Telstra Pty Ltd");
    expect((await store.findActiveDraft(PHONE))?.extraction?.vendor.value).toBe("Telstra Pty Ltd");
  });

  it("edits the date, normalising to ISO and re-gating", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction({ date: { value: null, confidence: 0 } }));
    await handleDraftReply(textEvent("5"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("10/08/2026"), editing!, deps);

    expect(send.sent[1]?.text).toContain("✅ Date updated — 2026-08-10");
    const updated = await store.findActiveDraft(PHONE);
    expect(updated?.extraction?.date.value).toBe("2026-08-10");
    expect(updated?.gateLevel).toBe("high");
  });

  it("`4` cancels the amount edit without touching the extraction", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("2"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("4"), editing!, deps);

    expect(send.sent[1]?.text).toContain(EDIT_CANCELLED_TEXT);
    const updated = await store.findActiveDraft(PHONE);
    expect(updated?.flowState).toBe("awaiting_confirm");
    expect(updated?.extraction?.amount.value).toBe(245.0);
  });

  it("`4` cancels a from-scratch (manual-entry) amount edit and leaves the amount missing", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction({ amount: { value: null, confidence: 0 } }));
    await handleDraftReply(textEvent("2"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("4"), editing!, deps);

    expect(send.sent[1]?.text).toContain(EDIT_CANCELLED_TEXT);
    const updated = await store.findActiveDraft(PHONE);
    expect(updated?.flowState).toBe("awaiting_confirm");
    expect(updated?.extraction?.amount.value).toBeNull();
    // Still a live draft, not skipped/expired — the cancel only backs out
    // of the edit sub-flow, it doesn't discard the whole bill.
    expect(updated?.status).not.toBe("expired");
  });

  it("`4` cancels the vendor and date edits too", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("3"), draft, deps);
    await handleDraftReply(textEvent("4"), (await store.findActiveDraft(PHONE))!, deps);
    expect((await store.findActiveDraft(PHONE))?.flowState).toBe("awaiting_confirm");

    await handleDraftReply(textEvent("5"), (await store.findActiveDraft(PHONE))!, deps);
    await handleDraftReply(textEvent("4"), (await store.findActiveDraft(PHONE))!, deps);
    expect((await store.findActiveDraft(PHONE))?.flowState).toBe("awaiting_confirm");
  });

  it("edits the category, lower-casing the reply", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("6"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("Rent"), editing!, deps);

    expect(send.sent[1]?.text).toContain("✅ Category updated — rent");
    expect((await store.findActiveDraft(PHONE))?.extraction?.category_hint.value).toBe("rent");
  });

  it("re-prompts on an empty category and stays in the sub-flow", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("6"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("   "), editing!, deps);

    expect(send.sent[1]?.text).toContain("Reply with a category");
    expect((await store.findActiveDraft(PHONE))?.flowState).toBe("editing_category");
  });

  it("`4` cancels the category edit without touching the extraction", async () => {
    const { store, send, deps } = makeDeps();
    const draft = await makeDraft(store, extraction());
    await handleDraftReply(textEvent("6"), draft, deps);
    const editing = await store.findActiveDraft(PHONE);
    await handleDraftReply(textEvent("4"), editing!, deps);

    expect(send.sent[1]?.text).toContain(EDIT_CANCELLED_TEXT);
    const updated = await store.findActiveDraft(PHONE);
    expect(updated?.flowState).toBe("awaiting_confirm");
    expect(updated?.extraction?.category_hint.value).toBe("utilities");
  });
});

describe("delete / undo (§5.6/§5.8 windows)", () => {
  async function seedLogged(store: FakeDraftStore, minutesAgo: number, autoLogged = false) {
    const draft = await makeDraft(store, extraction());
    const confirmed = await store.confirm(draft.id, new Date(Date.now() - minutesAgo * 60_000));
    if (autoLogged) store.markAutoLogged(confirmed!.id);
    return confirmed!;
  }

  it("nothing to undo when no transaction exists", async () => {
    const { deps, send } = makeDeps();
    const reply = await handleCommand(textEvent("delete"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(UNDO_NOTHING_TEXT);
    expect(send.sent).toHaveLength(0);
  });

  it("undoes a confirm-path transaction within 5 minutes", async () => {
    const { store, deps } = makeDeps();
    await seedLogged(store, 2);
    const reply = await handleCommand(textEvent("delete"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(UNDONE_TEXT);
  });

  it("rejects a confirm-path transaction older than 5 minutes", async () => {
    const { store, deps } = makeDeps();
    await seedLogged(store, 10);
    const reply = await handleCommand(textEvent("delete"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(UNDO_WINDOW_TEXT);
  });

  it("allows the 24 h window for auto-logged transactions", async () => {
    const { store, deps } = makeDeps();
    await seedLogged(store, 10, true);
    const reply = await handleCommand(textEvent("delete"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(UNDONE_TEXT);
  });
});

describe("autosave on/off (§5.8 opt-out)", () => {
  it("turns auto-log off and persists it on the business", async () => {
    const { businesses, deps } = makeDeps();
    businesses.addBusiness({
      id: "biz-1",
      name: "My Business",
      abn: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
    });
    const reply = await handleCommand(textEvent("autosave off"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(AUTOSAVE_OFF_TEXT);
    expect((await businesses.findBusiness("biz-1"))?.autoSave).toBe(false);
  });

  it("turns auto-log back on", async () => {
    const { businesses, deps } = makeDeps();
    businesses.addBusiness({
      id: "biz-1",
      name: "My Business",
      abn: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: false,
    });
    const reply = await handleCommand(textEvent("autosave on"), {
      users: deps.users,
      drafts: deps.drafts,
      businesses: deps.businesses,
      config: deps.config,
    });
    expect(reply).toBe(AUTOSAVE_ON_TEXT);
    expect((await businesses.findBusiness("biz-1"))?.autoSave).toBe(true);
  });
});
