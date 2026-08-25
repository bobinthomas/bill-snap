import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { loadConfig } from "../src/config";
import { createExtractionService } from "../src/extraction/pipeline";
import { createApp } from "../src/index";
import { createMockMessenger } from "../src/messaging/mock";
import { HELP_TEXT, UNKNOWN_COMMAND_TEXT, WELCOME_TEXT } from "../src/messaging/screens";
import { route } from "../src/webhook/router";
import type { InboundEvent } from "../src/types";
import { FakeBillStorage, FakeBusinessStore, FakeDraftStore, FakeTransactionStore, FakeUserStore } from "./fakes";

const APP_SECRET = "test-app-secret";
const ENV = { WHATSAPP_APP_SECRET: APP_SECRET };

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

function textEvent(text: string, userPhone = "61412345678"): InboundEvent {
  return {
    userPhone,
    waMessageId: "wamid." + Math.random().toString(36).slice(2),
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "text",
    text,
  };
}

const KNOWN = new FakeUserStore([
  { phoneNumber: "61412345678", businessId: "biz-1", createdAt: new Date() },
]);

function routeDeps(send = createMockMessenger(), users = KNOWN) {
  const config = loadConfig({});
  return {
    users,
    businesses: new FakeBusinessStore(users),
    drafts: new FakeDraftStore(),
    transactions: new FakeTransactionStore(),
    extraction: createExtractionService(config),
    send,
    storage: new FakeBillStorage(),
    config,
  };
}

describe("route (§5.6)", () => {
  it("sends the welcome to an unknown user", async () => {
    const send = createMockMessenger();
    const deps = routeDeps(send, new FakeUserStore([]));
    await route(textEvent("hello"), deps);
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.to).toBe("61412345678");
    expect(send.sent[0]?.text).toBe(WELCOME_TEXT);
  });

  it("answers `help` for a known user", async () => {
    const send = createMockMessenger();
    await route(textEvent("help"), routeDeps(send));
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.text).toBe(HELP_TEXT);
  });

  it("replies with the unknown-command hint for unrecognised text", async () => {
    const send = createMockMessenger();
    await route(textEvent("wages 500 rajesh"), routeDeps(send));
    expect(send.sent[0]?.text).toBe(UNKNOWN_COMMAND_TEXT);
  });

  it("prefers an active setup wizard over a pending draft", async () => {
    const send = createMockMessenger();
    const users = new FakeUserStore([
      { phoneNumber: "61412345678", businessId: "biz-1", createdAt: new Date() },
    ]);
    const businesses = new FakeBusinessStore(users);
    businesses.addBusiness({
      id: "biz-1",
      name: "My Business",
      abn: null,
      gstNumber: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
      address: null,
      phone: null,
    });
    const drafts = new FakeDraftStore();
    const deps = {
      users,
      businesses,
      drafts,
      transactions: new FakeTransactionStore(),
      extraction: createExtractionService(loadConfig({})),
      send,
      storage: new FakeBillStorage(),
      config: loadConfig({}),
    };

    // A bill is pending confirm…
    await drafts.createDraft({
      userPhone: "61412345678",
      waMessageId: "wamid.draft",
      imageUrls: ["MEDIA-1"],
      flowExpiresAt: new Date(Date.now() + 600_000),
    });
    // …and the user is mid-setup-wizard.
    await businesses.setSetupStep("61412345678", "name");

    // The reply must advance the wizard, not confirm the draft.
    await route(textEvent("My Plumbing Co"), deps);
    expect(send.sent.at(-1)?.text).toContain("Timezone");
    expect(await drafts.findActiveDraft("61412345678")).not.toBeNull();
  });
});

describe("end-to-end: POST /webhook → help round trip", () => {
  it("verifies, parses, routes, and sends the help reply", async () => {
    const send = createMockMessenger();
    const app = createApp({
      users: KNOWN,
      businesses: new FakeBusinessStore(KNOWN),
      drafts: new FakeDraftStore(),
      transactions: new FakeTransactionStore(),
      send,
      storage: new FakeBillStorage(),
    });

    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "61412345678",
                    id: "wamid.roundtrip",
                    timestamp: "1723000000",
                    type: "text",
                    text: { body: "help" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const res = await app.request(
      "/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
        body,
      },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.to).toBe("61412345678");
    expect(send.sent[0]?.text).toBe(HELP_TEXT);
  });

  it("does not route an unverified delivery", async () => {
    const send = createMockMessenger();
    const app = createApp({
      users: KNOWN,
      businesses: new FakeBusinessStore(KNOWN),
      drafts: new FakeDraftStore(),
      transactions: new FakeTransactionStore(),
      send,
      storage: new FakeBillStorage(),
    });

    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "1", id: "2", type: "text", text: { body: "help" } }] } }] }],
    });
    const res = await app.request(
      "/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
        body,
      },
      ENV,
    );

    expect(res.status).toBe(403);
    expect(send.sent).toHaveLength(0);
  });

  it("returns 503 when adapters are not configured (no deps, no env)", async () => {
    const app = createApp();
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "1", id: "2", type: "text", text: { body: "help" } }] } }] }],
    });
    const res = await app.request(
      "/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
        body,
      },
      ENV,
    );
    expect(res.status).toBe(503);
  });
});
