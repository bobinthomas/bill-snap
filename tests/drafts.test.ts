import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createExtractionService } from "../src/extraction/pipeline";
import { handlePhoto } from "../src/flows/photo";
import { createMockMessenger } from "../src/messaging/mock";
import { HELP_TEXT, UNKNOWN_COMMAND_TEXT } from "../src/messaging/screens";
import { route, type RouteDeps } from "../src/webhook/router";
import type { InboundEvent } from "../src/types";
import { FakeBillStorage, FakeBusinessStore, FakeDraftStore, FakeTransactionStore, FakeUserStore } from "./fakes";

const PHONE = "61412345678";

function photoEvent(waMessageId: string, userPhone = PHONE): InboundEvent {
  return {
    userPhone,
    waMessageId,
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "photo",
    imageUrls: ["MEDIA-1"],
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

function makeDeps() {
  const config = loadConfig({});
  const users = new FakeUserStore([{ phoneNumber: PHONE, businessId: "biz-1", createdAt: new Date() }]);
  const drafts = new FakeDraftStore();
  const send = createMockMessenger();
  const deps: RouteDeps = {
    users,
    businesses: new FakeBusinessStore(users),
    drafts,
    transactions: new FakeTransactionStore(),
    extraction: createExtractionService(config),
    send,
    storage: new FakeBillStorage(),
    config,
  };
  return { config, drafts, send, deps };
}

describe("handlePhoto (§5.6 draft creation)", () => {
  it("creates a draft with the idempotency key and acknowledges", async () => {
    const { config, drafts, send, deps } = makeDeps();
    await handlePhoto(photoEvent("wamid.photo1"), deps);

    const draft = await drafts.findActiveDraft(PHONE);
    expect(draft).not.toBeNull();
    expect(draft?.waMessageId).toBe("wamid.photo1");
    expect(draft?.imageUrls).toEqual(["MEDIA-1"]);
    // After the M5 pipeline, the draft waits for confirmation with a gated outcome.
    expect(draft?.flowState).toBe("awaiting_confirm");
    expect(draft?.gateLevel).toBeDefined();
    expect(draft?.machineRead).toBe(true);
    expect(draft?.extraction).toBeDefined();
    const expectedExpiry = Date.now() + config.ttl.draftMinutes * 60_000;
    expect(draft?.flowExpiresAt.getTime()).toBeGreaterThan(expectedExpiry - 2_000);
    expect(draft?.flowExpiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry + 2_000);

    // Ack first, then the §6.2 confirm screen.
    expect(send.sent).toHaveLength(2);
    expect(send.sent[0]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[1]?.text).toContain("📄 Bill Read");
  });

  it("ignores a retried delivery with the same wa_message_id", async () => {
    const { drafts, send, deps } = makeDeps();
    const event = photoEvent("wamid.retry");
    await handlePhoto(event, deps);
    const sentAfterFirst = send.sent.length; // ack + confirm screen
    await handlePhoto(event, deps);

    const active = await drafts.findActiveDraft(PHONE);
    expect(active?.waMessageId).toBe("wamid.retry");
    // The retried delivery is ignored — nothing new is sent or re-processed.
    expect(send.sent).toHaveLength(sentAfterFirst);
  });
});

describe("routing photos into the draft flow (§5.6)", () => {
  it("routes a photo to the draft flow instead of the command hint", async () => {
    const { send, deps } = makeDeps();
    await route(photoEvent("wamid.p1"), deps);
    expect(send.sent[0]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[1]?.text).not.toBe(UNKNOWN_COMMAND_TEXT);
  });

  it("sends the welcome to an unknown user even for photos", async () => {
    const send = createMockMessenger();
    const config = loadConfig({});
    const users = new FakeUserStore([]);
    const deps: RouteDeps = {
      users,
      businesses: new FakeBusinessStore(users),
      drafts: new FakeDraftStore(),
      transactions: new FakeTransactionStore(),
      extraction: createExtractionService(config),
      send,
      storage: new FakeBillStorage(),
      config,
    };
    await route(photoEvent("wamid.p2", "61499999999"), deps);
    expect(send.sent[0]?.text).toContain("Welcome to BillSnap");
  });

  it("routes a confirm reply into the draft flow, not to commands", async () => {
    const { send, deps } = makeDeps();
    await route(photoEvent("wamid.p3"), deps);
    send.sent.length = 0; // clear the ack + confirm screen
    await route(textEvent("1"), deps);

    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.text).toContain("✅ Logged:");
    // The draft is gone after confirming.
    const active = await deps.drafts.findActiveDraft(PHONE);
    expect(active).toBeNull();
  });

  it("answers help when no draft is active", async () => {
    const { send, deps } = makeDeps();
    await route(textEvent("help"), deps);
    expect(send.sent[0]?.text).toBe(HELP_TEXT);
  });
});

describe("findActiveDraft expiry", () => {
  it("does not return an expired draft (expiry on access)", async () => {
    const { drafts, deps } = makeDeps();
    const past = new Date(Date.now() - 1_000);
    await drafts.createDraft({
      userPhone: PHONE,
      waMessageId: "wamid.expired",
      imageUrls: [],
      flowExpiresAt: past,
    });

    const active = await drafts.findActiveDraft(PHONE, new Date());
    expect(active).toBeNull();

    // And the router treats that user as draft-free:
    const { send, deps: fresh } = makeDeps();
    const deps2 = { ...fresh, drafts };
    await route(textEvent("help"), deps2);
    expect(send.sent[0]?.text).toBe(HELP_TEXT);
  });
});
