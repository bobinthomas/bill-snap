/**
 * Local Supabase smoke test (SCAFFOLDING_PLAN.md §7).
 *
 * Runs the photo → confirm → undo round trip against the REAL Supabase stores
 * and the real `bills` storage bucket; only WhatsApp is substituted (a
 * recording mock — the point is the persistence layer).
 *
 *     npm run smoke          # after: supabase start; supabase db reset; .env.smoke
 *
 * Auto-skipped by `npm test` when no .env.smoke / SUPABASE_URL is present.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createSupabaseBusinessStore } from "../src/db/businesses";
import { createSupabaseDraftStore } from "../src/db/drafts";
import { createSupabaseUserStore } from "../src/db/users";
import { createExtractionService } from "../src/extraction/pipeline";
import { createMockMessenger } from "../src/messaging/mock";
import { UNDONE_TEXT, WELCOME_TEXT } from "../src/messaging/screens";
import { createSupabaseBillStorage } from "../src/storage/bills";
import { route, type RouteDeps } from "../src/webhook/router";
import type { InboundEvent } from "../src/types";

/** Read .env.smoke (gitignored) so the recipe works from any shell. */
function readSmokeEnv(): Record<string, string> {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env.smoke"), "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const DOTENV = readSmokeEnv();
// Accept both the legacy key names (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// and the CLI ≥2.114 `status -o env` names (API_URL / SERVICE_ROLE_KEY).
const SMOKE = {
  url: process.env.SUPABASE_URL ?? DOTENV.SUPABASE_URL ?? DOTENV.API_URL ?? "",
  key:
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    DOTENV.SUPABASE_SERVICE_ROLE_KEY ??
    DOTENV.SERVICE_ROLE_KEY ??
    "",
};

if (!SMOKE.url || !SMOKE.key) {
  console.warn(
    "[smoke] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — copy .env.smoke.example → .env.smoke after `supabase start` + `supabase db reset` (SCAFFOLDING_PLAN.md §7). Skipping.",
  );
}

describe.skipIf(!SMOKE.url || !SMOKE.key)("local Supabase smoke (photo → confirm → undo)", () => {
  const config = loadConfig({ ...DOTENV, ...process.env, SUPABASE_URL: SMOKE.url, SUPABASE_SERVICE_ROLE_KEY: SMOKE.key });
  const users = createSupabaseUserStore(config)!;
  const businesses = createSupabaseBusinessStore(config)!;
  const drafts = createSupabaseDraftStore(config)!;
  const storage = createSupabaseBillStorage(config)!;

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
  let storageDeletePath: string | undefined;

  function authHeaders(): Record<string, string> {
    return { apikey: SMOKE.key, Authorization: `Bearer ${SMOKE.key}` };
  }

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
    // Best-effort cleanup: the storage object and the rows this run created.
    if (storageDeletePath) {
      try {
        await fetch(`${SMOKE.url}${storageDeletePath}`, { method: "DELETE", headers: authHeaders() });
      } catch {
        // ignore — already gone
      }
    }
    const user = await users.findUser(phone).catch(() => null);
    try {
      await fetch(`${SMOKE.url}/rest/v1/transactions?user_phone=eq.${phone}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      // ignore
    }
    if (user?.businessId) {
      try {
        await fetch(`${SMOKE.url}/rest/v1/memberships?business_id=eq.${user.businessId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        await fetch(`${SMOKE.url}/rest/v1/businesses?id=eq.${user.businessId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
      } catch {
        // ignore
      }
    }
    try {
      await fetch(`${SMOKE.url}/rest/v1/users?phone_number=eq.${phone}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      // ignore
    }
  });

  it("onboards an unknown number, reads the photo, and uploads it to the bills bucket", async () => {
    await route(photoEvent("wamid.smoke.1"), deps);

    // welcome → ack → confirm screen (fixture bytes never extract → machine-read).
    expect(send.sent[0]?.text).toBe(WELCOME_TEXT);
    expect(send.sent[1]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[2]?.text).toContain("📄 Bill Read");

    const draft = await drafts.findActiveDraft(phone);
    expect(draft).not.toBeNull();
    expect(draft?.machineRead).toBe(true);

    // The storage URL replaced the media ID, and the object really exists.
    const url = draft?.imageUrls[0];
    expect(url?.startsWith(`${SMOKE.url}/storage/v1/object/public/bills/`)).toBe(true);
    storageDeletePath = new URL(url!).pathname.replace("/public", "");
    const object = await fetch(url!);
    expect(object.status).toBe(200);
    expect(await object.text()).toBe("fake-smoke-jpeg-bytes");
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
