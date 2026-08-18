/**
 * End-to-end smoke test (§5.5, SCAFFOLDING_PLAN.md §7) — the real webhook
 * router against the REAL D1 + R2 stores.
 *
 * Runs the photo → confirm → undo round trip through the production store
 * implementations (D1 stores over a node:sqlite shim running the real
 * migration SQL, R2 storage over a fake bucket); only WhatsApp is substituted
 * (a recording mock — the point is the persistence layer).
 *
 *     npx vitest run tests/smoke.test.ts
 *
 * Always runs — no Docker, no Supabase, no secrets (unlike the old
 * Supabase-era version which needed `supabase start` + .env.smoke).
 */
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createD1BusinessStore } from "../src/db/businesses";
import { createD1DraftStore } from "../src/db/drafts";
import { createD1UserStore } from "../src/db/users";
import { createExtractionService } from "../src/extraction/pipeline";
import { createMockMessenger } from "../src/messaging/mock";
import { UNDONE_TEXT, WELCOME_TEXT } from "../src/messaging/screens";
import type { R2Like } from "../src/storage/bills";
import { createR2BillStorage } from "../src/storage/bills";
import { route, type RouteDeps } from "../src/webhook/router";
import type { InboundEvent } from "../src/types";
import { createTestD1 } from "./fakes";

/** Fake R2 bucket: records puts, so the test can assert the object really landed. */
function fakeR2(): { bucket: R2Like; puts: Array<{ key: string; bytes: Uint8Array }> } {
  const puts: Array<{ key: string; bytes: Uint8Array }> = [];
  const bucket: R2Like = {
    async put(key, value) {
      puts.push({ key, bytes: value as Uint8Array });
      return {};
    },
  };
  return { bucket, puts };
}

describe("local D1 smoke (photo → confirm → undo)", () => {
  const config = loadConfig({});
  const db = createTestD1();
  const { bucket, puts } = fakeR2();

  const users = createD1UserStore(db);
  const businesses = createD1BusinessStore(db);
  const drafts = createD1DraftStore(db);
  const storage = createR2BillStorage(bucket);

  const send = createMockMessenger({
    media: {
      "SMOKE-MEDIA": {
        bytes: new TextEncoder().encode("fake-smoke-jpeg-bytes"),
        mimeType: "image/jpeg",
      },
    },
  });
  const deps: RouteDeps = {
    users,
    businesses,
    drafts,
    extraction: createExtractionService(config),
    send,
    storage,
    config,
  };

  // A fresh number per run: onboarding auto-creates a business, and no stale
  // draft from a previous run can interfere.
  const phone = "614" + String(Date.now() % 100_000_000).padStart(8, "0");

  function photoEvent(waMessageId: string): InboundEvent {
    return {
      userPhone: phone,
      waMessageId,
      waReceivedAt: new Date(),
      kind: "photo",
      imageUrls: ["SMOKE-MEDIA"],
    };
  }

  function textEvent(text: string): InboundEvent {
    return {
      userPhone: phone,
      waMessageId: "wamid." + Math.random().toString(36).slice(2),
      waReceivedAt: new Date(),
      kind: "text",
      text,
    };
  }

  afterAll(async () => {
    // Best-effort cleanup of the rows this run created (in-memory DB, but keep
    // the suite idempotent for a shared runner).
    const user = await users.findUser(phone).catch(() => null);
    if (user?.businessId) {
      await businesses.updateBusiness(user.businessId, {}).catch(() => {});
    }
  });

  it("onboards an unknown number, reads the photo, and uploads it to R2", async () => {
    await route(photoEvent("wamid.smoke.1"), deps);

    // welcome → ack → confirm screen (fixture bytes never extract → machine-read).
    expect(send.sent[0]?.text).toBe(WELCOME_TEXT);
    expect(send.sent[1]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[2]?.text).toContain("📄 Bill Read");

    const draft = await drafts.findActiveDraft(phone);
    expect(draft).not.toBeNull();
    expect(draft?.machineRead).toBe(true);

    // The R2 storage URL replaced the media ID, and the object really landed.
    const url = draft?.imageUrls[0];
    expect(url?.startsWith("/bills/")).toBe(true);
    expect(puts).toHaveLength(1);
    expect(new TextDecoder().decode(puts[0]!.bytes)).toBe("fake-smoke-jpeg-bytes");
  });

  it("confirms the draft and undoes it through the real stores", async () => {
    await route(textEvent("1"), deps);
    expect(send.sent[3]?.text).toContain("✅ Logged:");

    // 60 s window like the rest of the suite — `new Date()` would ask for rows
    // confirmed after "now", which a just-confirmed row can never satisfy.
    const logged = await drafts.findRecentLogged(phone, new Date(Date.now() - 60_000));
    expect(logged?.status).toBe("logged");
    expect(logged?.autoLogged).toBe(false);
    expect(logged?.imageUrls[0]).toContain("/bills/");

    await route(textEvent("delete"), deps);
    expect(send.sent[4]?.text).toBe(UNDONE_TEXT);
    expect(await drafts.findRecentLogged(phone, new Date(Date.now() - 60_000))).toBeNull();
  });
});
