import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { ExtractionService } from "../src/extraction/pipeline";
import { normaliseExtraction } from "../src/extraction/validate";
import { handleSetupReply } from "../src/flows/onboarding";
import {
  SETUP_DONE_TEXT,
  SETUP_GST_PROMPT,
  SETUP_NAME_PROMPT,
  SETUP_TIMEZONE_PROMPT,
  WELCOME_TEXT,
} from "../src/messaging/screens";
import { createMockMessenger, type MockMessenger } from "../src/messaging/mock";
import type { InboundEvent } from "../src/types";
import type { BillExtraction } from "../src/types";
import { route, type RouteDeps } from "../src/webhook/router";
import { FakeBillStorage, FakeBusinessStore, FakeDraftStore, FakeTransactionStore, FakeUserStore } from "./fakes";

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

function textEvent(text: string, userPhone = PHONE): InboundEvent {
  return {
    userPhone,
    waMessageId: "wamid." + Math.random().toString(36).slice(2),
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "text",
    text,
  };
}

function photoEvent(waMessageId: string, userPhone = PHONE): InboundEvent {
  return {
    userPhone,
    waMessageId,
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "photo",
    imageUrls: ["MEDIA-1"],
  };
}

async function makeDeps(opts: {
  extraction?: ExtractionService;
  known?: boolean;
} = {}): Promise<{
  users: FakeUserStore;
  businesses: FakeBusinessStore;
  store: FakeDraftStore;
  send: MockMessenger;
  deps: RouteDeps;
}> {
  const users = new FakeUserStore([]);
  const businesses = new FakeBusinessStore(users);
  // A "known" user is onboarded so the user + business rows are consistent.
  if (opts.known) await businesses.onboard(PHONE);
  const store = new FakeDraftStore();
  const send = createMockMessenger();
  const deps: RouteDeps = {
    users,
    businesses,
    drafts: store,
    transactions: new FakeTransactionStore(),
    extraction:
      opts.extraction ??
      ({
        // Faithful fake: applies the validation layer so gst_registered flows through.
        run: async ({ gstRegistered = true }) => {
          const normalised = normaliseExtraction(extraction(), gstRegistered);
          return { extraction: normalised, gate: "high", machineRead: false, source: "ai" };
        },
      }),
    send,
    storage: new FakeBillStorage(),
    config: CONFIG,
  };
  return { users, businesses, store, send, deps };
}

describe("onboarding (§4.5)", () => {
  it("auto-creates user + business + membership and welcomes a text first-contact", async () => {
    const { users, businesses, send, deps } = await makeDeps();
    await route(textEvent("hello"), deps);

    const user = await users.findUser(PHONE);
    expect(user).not.toBeNull();
    const business = await businesses.findBusiness(user!.businessId!);
    expect(business).toEqual({
      id: business!.id,
      name: "My Business",
      abn: null,
      gstNumber: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
      address: null,
      phone: null,
    });
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.text).toBe(WELCOME_TEXT);
  });

  it("is idempotent — a second first-contact keeps the existing business", async () => {
    const { users, businesses, deps } = await makeDeps();
    await route(textEvent("hello"), deps);
    const before = (await users.findUser(PHONE))!.businessId;
    await route(textEvent("hi again"), deps);
    expect((await users.findUser(PHONE))!.businessId).toBe(before);
    expect(await businesses.findBusiness(before!)).not.toBeNull();
  });

  it("a photo first-contact proceeds into the photo flow after onboarding", async () => {
    const { users, businesses, send, deps } = await makeDeps();
    await route(photoEvent("wamid.onb1"), deps);

    expect((await users.findUser(PHONE))).not.toBeNull();
    expect((await businesses.findBusiness((await users.findUser(PHONE))!.businessId!))).not.toBeNull();
    // welcome → ack → auto-log reply (the fake extraction is high + not machine-read)
    expect(send.sent[0]?.text).toBe(WELCOME_TEXT);
    expect(send.sent[1]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[2]?.text).toContain("✅ Logged:");
  });
});

describe("setup wizard (§4.5)", () => {
  it("walks name → timezone → GST and saves the business", async () => {
    const { businesses, send, deps } = await makeDeps({ known: true });
    await route(textEvent("setup"), deps);
    expect(send.sent[0]?.text).toBe(SETUP_NAME_PROMPT);

    await route(textEvent("Rajesh Electrical"), deps);
    expect(send.sent[1]?.text).toBe(SETUP_TIMEZONE_PROMPT);

    await route(textEvent("perth"), deps);
    expect(send.sent[2]?.text).toBe(SETUP_GST_PROMPT);

    await route(textEvent("no"), deps);
    expect(send.sent[3]?.text).toBe(SETUP_DONE_TEXT);

    const user = await deps.users.findUser(PHONE);
    const business = await businesses.findBusiness(user!.businessId!);
    expect(business?.name).toBe("Rajesh Electrical");
    expect(business?.timezone).toBe("Australia/Perth");
    expect(business?.gstRegistered).toBe(false);
  });

  it("supports `skip` to keep defaults", async () => {
    const { businesses, send, deps } = await makeDeps({ known: true });
    await route(textEvent("setup"), deps);
    await route(textEvent("skip"), deps);
    await route(textEvent("skip"), deps);
    await route(textEvent("skip"), deps);
    expect(send.sent[3]?.text).toBe(SETUP_DONE_TEXT);

    const user = await deps.users.findUser(PHONE);
    const business = await businesses.findBusiness(user!.businessId!);
    expect(business?.name).toBe("My Business");
    expect(business?.timezone).toBe("Australia/Sydney");
    expect(business?.gstRegistered).toBe(true);
  });

  it("re-prompts on an invalid timezone and keeps the wizard active", async () => {
    const { send, deps } = await makeDeps({ known: true });
    await route(textEvent("setup"), deps);
    await route(textEvent("skip"), deps);
    await route(textEvent("mars"), deps);
    expect(send.sent[2]?.text).toContain("Reply one of:");
    expect(await deps.businesses.getSetupStep(PHONE)).toBe("timezone");
  });

  it("wizard replies are routed before commands", async () => {
    const { send, deps } = await makeDeps({ known: true });
    await route(textEvent("setup"), deps);
    // "help" during the wizard is treated as a name, not the help command.
    await route(textEvent("help"), deps);
    expect(await deps.businesses.getSetupStep(PHONE)).toBe("timezone");
    expect(send.sent).toHaveLength(2);
  });
});

describe("auto-log (§5.8)", () => {
  it("auto-logs a High, non-machine-read extraction with the 24 h window", async () => {
    const { store, send, deps } = await makeDeps({ known: true });
    await route(photoEvent("wamid.auto1"), deps);

    expect(send.sent[1]?.text).toContain("✅ Logged:");
    expect(send.sent[1]?.text).toContain("within 24 hours to undo");
    expect(send.sent[1]?.text).not.toContain("📄 Bill Read");
    const logged = await store.findRecentLogged(PHONE, new Date(Date.now() - 60_000));
    expect(logged?.autoLogged).toBe(true);
    expect(await store.findActiveDraft(PHONE)).toBeNull();
  });

  it("does not auto-log when the business has auto_save disabled", async () => {
    const { businesses, send, deps } = await makeDeps({ known: true });
    const user = await deps.users.findUser(PHONE);
    await businesses.updateBusiness(user!.businessId!, { autoSave: false });
    await route(photoEvent("wamid.auto2"), deps);

    expect(send.sent[1]?.text).toContain("📄 Bill Read");
    expect(await deps.drafts.findActiveDraft(PHONE)).not.toBeNull();
  });

  it("skips auto-log when a duplicate invoice was logged recently", async () => {
    const { store, send, deps } = await makeDeps({ known: true });
    // Seed a logged transaction with the same invoice number, then the auto-log
    // path must fall back to the confirm screen.
    const created = await store.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.dupseed",
      imageUrls: [],
      flowExpiresAt: new Date(Date.now() + 600_000),
    });
    await store.setFlowState(created!.id, {
      flowState: "awaiting_confirm",
      extraction: extraction(),
      gateLevel: "high",
      machineRead: false,
    });
    await store.confirm(created!.id, new Date(), { autoLogged: true });

    await route(photoEvent("wamid.auto3"), deps);
    expect(send.sent[1]?.text).toContain("📄 Bill Read");
  });

  it("wires businesses.gst_registered into extraction", async () => {
    const { businesses, send, deps } = await makeDeps({ known: true });
    const user = await deps.users.findUser(PHONE);
    await businesses.updateBusiness(user!.businessId!, { gstRegistered: false });

    await route(photoEvent("wamid.gst1"), deps);
    expect(send.sent[1]?.text).toContain("GST: —");
  });
});

describe("handleSetupReply directly", () => {
  it("cancels cleanly when the business is missing", async () => {
    const { businesses, deps } = await makeDeps({ known: true });
    // Put the user in the wizard, then delete the business so lookup fails.
    await deps.businesses.setSetupStep(PHONE, "name");
    const user = await deps.users.findUser(PHONE);
    (businesses as unknown as { businesses: Map<string, unknown> }).businesses.delete(user!.businessId!);
    await handleSetupReply(textEvent("X"), deps);
    expect(await deps.businesses.getSetupStep(PHONE)).toBeNull();
  });
});
