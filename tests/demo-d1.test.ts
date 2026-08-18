/**
 * The D1-backed demo path (tests/demo.test.ts covers the in-memory path).
 *
 * /dev/demo and /dev/dashboard switch to the REAL D1 + R2 stores when the
 * bindings are present. This test proves that path end to end against a real
 * SQLite D1 shim (node:sqlite running the same migrations/0001_schema.sql as
 * production) plus a fake R2 bucket:
 * photo → onboarding → confirm → a FRESH dashboard read, so entries survive a
 * page reload (every call builds new stores from the bindings — nothing is
 * cached in module memory when D1 is present).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { dashboardData } from "../src/dev/dashboard";
import { DEMO_PHONE, demoState, resetDemo, simulatePhoto, simulateText } from "../src/dev/demo";
import type { R2Like } from "../src/storage/bills";
import type { BillExtraction } from "../src/types";
import { createTestD1 } from "./fakes";

interface R2Put {
  key: string;
  bytes: Uint8Array;
  contentType?: string;
}

/** A fake R2 bucket recording puts — the narrow surface the store uses. */
function fakeR2(): { bucket: R2Like; puts: R2Put[] } {
  const puts: R2Put[] = [];
  const bucket: R2Like = {
    async put(key, value, options) {
      puts.push({ key, bytes: value as Uint8Array, contentType: options?.httpMetadata?.contentType });
      return {};
    },
  };
  return { bucket, puts };
}

/** What the regex extractor produces for "internet 99.95 telstra gst". */
const EXTRACTION: BillExtraction = {
  amount: { value: 99.95, confidence: 0.98 },
  date: { value: null, confidence: 0 },
  vendor: { value: "telstra", confidence: 0.9 },
  abn: { value: null, confidence: 0 },
  gst: { value: null, confidence: 0 },
  gst_basis: "none",
  invoice_number: { value: null, confidence: 0 },
  due_date: { value: null, confidence: 0 },
  category_hint: { value: "internet", confidence: 0.9 },
};

interface DemoJson {
  messages: Array<{ from: "user" | "bot"; text: string }>;
  draft: {
    id: string;
    flowState: string | null;
    status: string;
    gateLevel?: string;
    machineRead?: boolean;
    extraction?: { amount: number | null; date: string | null; vendor: string | null };
  } | null;
  persistence: "d1" | "in-memory";
}

describe("demo with real D1 + R2 stores configured (dev:full)", () => {
  beforeEach(() => resetDemo());

  it("runs photo → confirm → dashboard through the D1 stores; fresh reads survive reload", async () => {
    const config = loadConfig({});
    const db = createTestD1();
    const { bucket, puts } = fakeR2();
    const bindings = { db, bills: bucket };

    // Photo: unknown number → onboarding (business auto-create) → confirm screen.
    await simulatePhoto(config, undefined, "bill.jpg", "internet 99.95 telstra gst", undefined, bindings);
    const afterPhoto = (await demoState(config, undefined, bindings)) as DemoJson;
    expect(afterPhoto.persistence).toBe("d1");
    expect(afterPhoto.messages.some((m) => m.text.includes("Welcome to BillSnap"))).toBe(true);
    expect(afterPhoto.draft?.flowState).toBe("awaiting_confirm");
    expect(afterPhoto.draft?.machineRead).toBe(true); // regex/OCR path stays machine-read
    expect(afterPhoto.draft?.extraction?.amount).toBe(99.95);

    // Onboarding wrote rows into the real D1 schema: business + user + owner membership.
    const business = await db.prepare("select id, name from businesses").first<{ id: string; name: string }>();
    expect(business?.name).toBe("My Business");
    const user = await db
      .prepare("select phone_number from users where phone_number = ?")
      .bind(DEMO_PHONE)
      .first<{ phone_number: string }>();
    expect(user?.phone_number).toBe(DEMO_PHONE);
    const memberships = await db.prepare("select count(*) as n from memberships").first<{ n: number }>();
    expect(Number(memberships?.n)).toBe(1);

    // The R2 upload carried the downloaded fixture bytes, tenant-scoped path.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key.startsWith(`${business!.id}/2026/`)).toBe(true);
    expect(new TextDecoder().decode(puts[0]!.bytes)).toBe("bill-snap-demo-image");
    expect(puts[0]!.contentType).toBe("image/jpeg");
    // The draft's image URLs are the same-origin /bills/ paths, not the media IDs.
    const draft = await db.prepare("select image_urls from transactions").first<{ image_urls: string }>();
    expect(draft?.image_urls).toContain("/bills/");

    // Confirm with 1️⃣ → logged via the D1 store.
    await simulateText(config, undefined, "1", bindings);
    const afterConfirm = (await demoState(config, undefined, bindings)) as DemoJson;
    expect(afterConfirm.messages.some((m) => m.text.includes("✅ Logged:"))).toBe(true);
    expect(afterConfirm.draft).toBeNull(); // findActiveDraft → no active draft after logging

    const logged = await db
      .prepare("select status, flow_state, amount from transactions where status = 'logged'")
      .first<{ status: string; flow_state: string | null; amount: number }>();
    expect(logged?.status).toBe("logged");
    expect(logged?.flow_state).toBeNull();
    expect(logged?.amount).toBe(99.95);

    // FRESH dashboard read (a page reload builds new stores from the bindings —
    // the data comes from the store, not the demo's module memory).
    const data = await dashboardData(config, {}, bindings);
    expect(data.persistence).toBe("d1");
    expect(data.totals.count).toBe(1);
    expect(data.totals.amount).toBe(99.95);
    expect(data.rows[0]).toMatchObject({ vendor: "telstra", amount: 99.95 });
  });

  it("keeps persistence in-memory when no bindings are present", async () => {
    const config = loadConfig({});
    await simulatePhoto(config, undefined, undefined, "internet 99.95 telstra gst");
    const state = (await demoState(config)) as DemoJson;
    expect(state.persistence).toBe("in-memory");
    expect(state.draft?.extraction?.amount).toBe(99.95);
  });
});
