/**
 * BillSnap Worker entry point (SCAFFOLDING_PLAN.md §5).
 *
 * Routes:
 * - GET  /webhook  — WhatsApp verify-token handshake (§7.2)
 * - POST /webhook  — X-Hub-Signature-256 verification → parse → route (§5.6)
 * - GET  /health   — skeleton health check (M0)
 * - GET  /bills/*  — serves bill images from the R2 bucket (same-origin URLs)
 * - scheduled    — nudge + expiry sweep (cron, §5.6/§6.2)
 *
 * `createApp` accepts optional dependency overrides (used by tests); the default
 * export builds the production app with the real D1/R2/Workers AI adapters —
 * everything stays inside Cloudflare (§5.5: D1 for the data model, R2 for
 * bill images, Workers AI for the fallback parser). No Supabase.
 */
import type { D1Database, ExecutionContext, R2Bucket, ScheduledController } from "@cloudflare/workers-types";
import type { CloudBindings } from "./bindings";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { loadConfig } from "./config";
import {
  billsToCsv,
  dashboardBillData,
  dashboardBillsData,
  dashboardData,
  dashboardSettingsData,
  deleteDashboardBill,
  exportFileName,
  renderDashboardBillEditPage,
  renderDashboardBillsPage,
  renderDashboardPage,
  renderDashboardSettingsPage,
  saveDashboardBillEdit,
  saveDashboardSettings,
  switchDashboardCompany,
} from "./dev/dashboard";
import { DEMO_MEDIA_ID, demoDeps, demoState, renderDemoPage, setDemoMedia, simulatePhoto, simulateText } from "./dev/demo";
import {
  renderWebAppPage,
  stashWebMedia,
  webAction,
  webAppState,
  webCompanies,
  webHasBusiness,
  webManualEntry,
  webPhoto,
  webResolveDuplicate,
  webSelectCompany,
  webSetup,
} from "./webapp/app";
import { createD1BusinessStore, type BusinessStore } from "./db/businesses";
import { createD1DraftStore, type DraftStore } from "./db/drafts";
import { createD1TransactionStore, type TransactionStore } from "./db/transactions";
import { createD1UserStore, type UserStore } from "./db/users";
import { CATEGORIES } from "./extraction/vendor-categories";
import { createExtractionService, type ExtractionService } from "./extraction/pipeline";
import type { WorkersAi } from "./extraction/workers-ai";
import { runSweep } from "./flows/nudge";
import { createWhatsAppMessenger, type Messenger } from "./messaging/whatsapp";
import { createR2BillStorage, type BillStorage } from "./storage/bills";
import { parseInbound } from "./webhook/parse";
import { route, type RouteDeps } from "./webhook/router";
import { verifySignature, verifyToken } from "./webhook/verify";

type Env = {
  [key: string]: string | undefined;
} & {
  /** D1 database binding (§5.5) — the data model. */
  DB?: D1Database;
  /** R2 bucket binding — bill images (§5.5). */
  BILLS?: R2Bucket;
};

/** The `env.AI` Workers AI binding, if the runtime provides it (§5.3). */
function aiBinding(env: Env): WorkersAi | undefined {
  return (env as unknown as { AI?: WorkersAi }).AI;
}

/** D1 + R2 as the deps layer's CloudBindings — the real stores when present. */
function cloudBindings(env: Env): CloudBindings {
  return { db: env.DB, bills: env.BILLS };
}

export interface AppDeps {
  users?: UserStore;
  businesses?: BusinessStore;
  drafts?: DraftStore;
  transactions?: TransactionStore;
  extraction?: ExtractionService;
  send?: Messenger;
  storage?: BillStorage;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", (c) => {
    return c.redirect("/app");
  });

  // DEV-only browser demo (simulated WhatsApp) — gated on config.devDemo.
  const devDemo = (env: Env) => loadConfig(env).devDemo;
  app.get("/dev/demo", (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    return c.html(renderDemoPage());
  });
  app.get("/dev/demo/state", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    return c.json(await demoState(loadConfig(c.env), aiBinding(c.env), cloudBindings(c.env)));
  });
  app.post("/dev/demo/photo", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const config = loadConfig(c.env);
    // Accept an optional multipart image so the demo can run the REAL image
    // path (M8): the bytes are stashed for the messenger's downloadMedia,
    // which the photo flow archives to the bills bucket.
    let fileName: string | undefined;
    let ocrText: string | undefined;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (file instanceof File) {
      setDemoMedia(DEMO_MEDIA_ID, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type || "image/jpeg",
        fileName: file.name,
      });
      fileName = file.name;
    }
    const ocr = form?.get("ocrText");
    if (typeof ocr === "string" && ocr.trim() !== "") ocrText = ocr;
    // Browser OCR settings label (the retry button cycles tesseract configs).
    const ocrConfig = form?.get("ocrConfig");
    const configLabel = typeof ocrConfig === "string" && ocrConfig.trim() !== "" ? ocrConfig : undefined;
    await simulatePhoto(config, aiBinding(c.env), fileName, ocrText, configLabel, cloudBindings(c.env));
    return c.json(await demoState(config, aiBinding(c.env), cloudBindings(c.env)));
  });
  app.post("/dev/demo/text", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "text required" }, 400);
    }
    await simulateText(config, aiBinding(c.env), body.text.trim(), cloudBindings(c.env));
    return c.json(await demoState(config, aiBinding(c.env), cloudBindings(c.env)));
  });

  // DEV-only analytics dashboard over the demo user's logged bills. Gated
  // behind DEV_DEMO (as before) AND HTTP Basic Auth (DASHBOARD_PASSWORD) —
  // this data (spend, GST, vendors) is real business data once deployed, not
  // just a dev toy, so it needs a real credential, not only an env flag.
  // Fails CLOSED: no password configured means no access, never open access.
  const DASHBOARD_USER = "billsnap";
  app.use("/dev/dashboard", async (c, next) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const password = loadConfig(c.env).dashboardPassword;
    if (!password) return c.text("DASHBOARD_PASSWORD not configured — see .env.example", 500);
    return basicAuth({ username: DASHBOARD_USER, password })(c, next);
  });
  app.use("/dev/dashboard/*", async (c, next) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const password = loadConfig(c.env).dashboardPassword;
    if (!password) return c.text("DASHBOARD_PASSWORD not configured — see .env.example", 500);
    return basicAuth({ username: DASHBOARD_USER, password })(c, next);
  });
  app.get("/dev/dashboard", (c) => {
    return c.html(renderDashboardPage());
  });
  app.get("/dev/dashboard/settings", async (c) => {
    const device = c.req.query("device") || undefined;
    const flashQ = c.req.query("flash");
    const flash = flashQ === "saved" || flashQ === "switched" ? flashQ : undefined;
    const prev = c.req.query("prev") || undefined;
    const switchNote = prev ? `Your in-progress bill will still be logged under ${prev}.` : undefined;
    const settingsData = await dashboardSettingsData(loadConfig(c.env), cloudBindings(c.env), device);
    return c.html(renderDashboardSettingsPage(settingsData, device, flash, switchNote));
  });
  app.post("/dev/dashboard/settings", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const device = (typeof form?.get("device") === "string" ? (form.get("device") as string) : "") || undefined;
    const str = (key: string) => {
      const v = form?.get(key);
      return typeof v === "string" ? v.trim() : "";
    };
    const name = str("name");
    const timezone = str("timezone");
    await saveDashboardSettings(loadConfig(c.env), cloudBindings(c.env), device, {
      ...(name ? { name } : {}),
      abn: str("abn"),
      gstNumber: str("gstNumber"),
      address: str("address"),
      phone: str("phone"),
      ...(timezone ? { timezone } : {}),
      gstRegistered: form?.get("gstRegistered") === "on",
      autoSave: form?.get("autoSave") === "on",
    });
    const params = new URLSearchParams();
    if (device) params.set("device", device);
    params.set("flash", "saved");
    return c.redirect(`/dev/dashboard/settings?${params.toString()}`);
  });
  app.post("/dev/dashboard/switch-company", async (c) => {
    const config = loadConfig(c.env);
    const bindings = cloudBindings(c.env);
    const form = await c.req.formData().catch(() => null);
    const device = (typeof form?.get("device") === "string" ? (form.get("device") as string) : "") || undefined;
    const businessId = form?.get("businessId");
    if (typeof businessId !== "string" || businessId.trim() === "") {
      return c.text("businessId required", 400);
    }
    const result = await switchDashboardCompany(config, bindings, device, businessId.trim());
    if (!result.ok) return c.text("Not found", 404);
    const params = new URLSearchParams();
    if (device) params.set("device", device);
    params.set("flash", "switched");
    if (result.hadActiveDraft && result.previousCompanyName) {
      params.set("draft", "1");
      params.set("prev", result.previousCompanyName);
    }
    return c.redirect(`/dev/dashboard/settings?${params.toString()}`);
  });
  app.get("/dev/dashboard/bills", async (c) => {
    const device = c.req.query("device") || undefined;
    const flashQ = c.req.query("flash");
    const flash = flashQ === "saved" || flashQ === "deleted" ? flashQ : undefined;
    const billsData = await dashboardBillsData(loadConfig(c.env), cloudBindings(c.env), device);
    return c.html(renderDashboardBillsPage(billsData, device, flash));
  });
  app.get("/dev/dashboard/bills/:id/edit", async (c) => {
    const device = c.req.query("device") || undefined;
    const { bill } = await dashboardBillData(loadConfig(c.env), cloudBindings(c.env), device, c.req.param("id"));
    if (!bill) return c.text("Not found", 404);
    return c.html(renderDashboardBillEditPage(bill, device));
  });
  app.post("/dev/dashboard/bills/:id/edit", async (c) => {
    const config = loadConfig(c.env);
    const bindings = cloudBindings(c.env);
    const id = c.req.param("id");
    const form = await c.req.formData().catch(() => null);
    const device = (typeof form?.get("device") === "string" ? (form.get("device") as string) : "") || undefined;
    const str = (key: string) => {
      const v = form?.get(key);
      return typeof v === "string" ? v.trim() : "";
    };
    const num = (key: string) => {
      const v = str(key);
      if (v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const categoryRaw = str("category");
    const category = (CATEGORIES as readonly string[]).includes(categoryRaw)
      ? (categoryRaw as (typeof CATEGORIES)[number])
      : undefined;
    const result = await saveDashboardBillEdit(config, bindings, device, id, {
      vendor: str("vendor") || null,
      ...(category ? { category } : {}),
      amount: num("amount"),
      gst: num("gst"),
      date: str("date") || null,
      invoiceNumber: str("invoiceNumber") || null,
      abn: str("abn") || null,
    });
    if (result === "not-found") return c.text("Not found", 404);
    const params = new URLSearchParams();
    if (device) params.set("device", device);
    params.set("flash", "saved");
    return c.redirect(`/dev/dashboard/bills?${params.toString()}`);
  });
  app.post("/dev/dashboard/bills/:id/delete", async (c) => {
    const config = loadConfig(c.env);
    const bindings = cloudBindings(c.env);
    const id = c.req.param("id");
    const form = await c.req.formData().catch(() => null);
    const device = (typeof form?.get("device") === "string" ? (form.get("device") as string) : "") || undefined;
    const result = await deleteDashboardBill(config, bindings, device, id);
    if (result === "not-found") return c.text("Not found", 404);
    const params = new URLSearchParams();
    if (device) params.set("device", device);
    params.set("flash", "deleted");
    return c.redirect(`/dev/dashboard/bills?${params.toString()}`);
  });
  app.get("/dev/dashboard/data", async (c) => {
    const q = c.req.query();
    return c.json(
      await dashboardData(
        loadConfig(c.env),
        {
          month: q.month || undefined,
          category: q.category || undefined,
          vendor: q.vendor || undefined,
        },
        cloudBindings(c.env),
        q.device || undefined,
      ),
    );
  });
  app.get("/dev/dashboard/export.csv", async (c) => {
    const q = c.req.query();
    const filters = {
      month: q.month || undefined,
      category: q.category || undefined,
      vendor: q.vendor || undefined,
    };
    const data = await dashboardData(loadConfig(c.env), filters, cloudBindings(c.env), q.device || undefined);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${exportFileName(filters, data.business?.name)}"`);
    return c.body(billsToCsv(data.business, data.rows));
  });

  // Mobile-first webapp (the primary flow; WhatsApp is on hold). Not gated on
  // DEV_DEMO — this is the product surface. Identity is a browser device id
  // used as `userPhone`, so the same router/extraction/stores run unchanged.
  app.get("/app", (c) => c.html(renderWebAppPage()));
  app.get("/app/state", async (c) => {
    const config = loadConfig(c.env);
    const device = c.req.query("device");
    if (!device) return c.json({ error: "device required" }, 400);
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.post("/app/setup", async (c) => {
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as {
      device?: unknown;
      name?: unknown;
      abn?: unknown;
      gstNumber?: unknown;
      address?: unknown;
      phone?: unknown;
      timezone?: unknown;
      gstRegistered?: unknown;
    };
    if (typeof body.device !== "string" || body.device.trim() === "") {
      return c.json({ error: "device required" }, 400);
    }
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name required" }, 400);
    }
    const device = body.device.trim();
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    await webSetup(config, aiBinding(c.env), device, cloudBindings(c.env), {
      name: body.name.trim(),
      abn: str(body.abn),
      gstNumber: str(body.gstNumber),
      address: str(body.address),
      phone: str(body.phone),
      timezone: str(body.timezone) || undefined,
      gstRegistered: body.gstRegistered === true,
    });
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.get("/app/companies", async (c) => {
    const config = loadConfig(c.env);
    const device = c.req.query("device")?.trim();
    if (!device) return c.json({ error: "device required" }, 400);
    const companies = await webCompanies(config, aiBinding(c.env), device, cloudBindings(c.env));
    return c.json({ companies });
  });
  app.post("/app/select-company", async (c) => {
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { device?: unknown; businessId?: unknown };
    if (typeof body.device !== "string" || body.device.trim() === "") {
      return c.json({ error: "device required" }, 400);
    }
    if (typeof body.businessId !== "string" || body.businessId.trim() === "") {
      return c.json({ error: "businessId required" }, 400);
    }
    const device = body.device.trim();
    const ok = await webSelectCompany(config, aiBinding(c.env), device, cloudBindings(c.env), body.businessId.trim());
    if (!ok) return c.json({ error: "company not found" }, 404);
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.post("/app/resolve-duplicate", async (c) => {
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { device?: unknown; draftId?: unknown; action?: unknown };
    if (typeof body.device !== "string" || body.device.trim() === "") {
      return c.json({ error: "device required" }, 400);
    }
    if (typeof body.draftId !== "string" || body.draftId.trim() === "") {
      return c.json({ error: "draftId required" }, 400);
    }
    if (body.action !== "keep" && body.action !== "discard") {
      return c.json({ error: "action must be 'keep' or 'discard'" }, 400);
    }
    const device = body.device.trim();
    const ok = await webResolveDuplicate(
      config,
      aiBinding(c.env),
      device,
      cloudBindings(c.env),
      body.draftId.trim(),
      body.action,
    );
    if (!ok) return c.json({ error: "no matching pending duplicate" }, 404);
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.post("/app/photo", async (c) => {
    const config = loadConfig(c.env);
    const form = await c.req.formData().catch(() => null);
    const deviceRaw = form?.get("device");
    const device = typeof deviceRaw === "string" && deviceRaw.trim() !== "" ? deviceRaw.trim() : null;
    if (!device) return c.json({ error: "device required" }, 400);
    if (!(await webHasBusiness(config, aiBinding(c.env), device, cloudBindings(c.env)))) {
      return c.json({ error: "setup required" }, 400);
    }
    let mediaId: string | null = null;
    let fileName: string | undefined;
    const file = form?.get("file");
    if (file instanceof File) {
      mediaId = stashWebMedia(device, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type || "image/jpeg",
        fileName: file.name,
      });
      fileName = file.name;
    }
    const ocr = form?.get("ocrText");
    const ocrText = typeof ocr === "string" && ocr.trim() !== "" ? ocr : undefined;
    const ocrCfg = form?.get("ocrConfig");
    const ocrConfig = typeof ocrCfg === "string" && ocrCfg.trim() !== "" ? ocrCfg : undefined;
    await webPhoto(config, aiBinding(c.env), device, mediaId, fileName, ocrText, ocrConfig, cloudBindings(c.env));
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.post("/app/manual", async (c) => {
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { device?: unknown };
    if (typeof body.device !== "string" || body.device.trim() === "") {
      return c.json({ error: "device required" }, 400);
    }
    const device = body.device.trim();
    if (!(await webHasBusiness(config, aiBinding(c.env), device, cloudBindings(c.env)))) {
      return c.json({ error: "setup required" }, 400);
    }
    await webManualEntry(config, aiBinding(c.env), device, cloudBindings(c.env));
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });
  app.post("/app/action", async (c) => {
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { device?: unknown; text?: unknown };
    if (typeof body.device !== "string" || body.device.trim() === "") {
      return c.json({ error: "device required" }, 400);
    }
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "text required" }, 400);
    }
    const device = body.device.trim();
    if (!(await webHasBusiness(config, aiBinding(c.env), device, cloudBindings(c.env)))) {
      return c.json({ error: "setup required" }, 400);
    }
    await webAction(config, aiBinding(c.env), device, body.text.trim(), cloudBindings(c.env));
    return c.json(await webAppState(config, aiBinding(c.env), device, cloudBindings(c.env)));
  });

  app.get("/health", (c) => {
    const config = loadConfig(c.env);
    return c.json({
      status: "ok",
      service: "bill-snap",
      secretsConfigured: {
        whatsapp: Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret),
        workersAi: Boolean(aiBinding(c.env)),
        d1: Boolean((c.env as unknown as { DB?: D1Database }).DB),
        r2: Boolean((c.env as unknown as { BILLS?: R2Bucket }).BILLS),
      },
    });
  });

  app.get("/webhook", (c) => {
    const config = loadConfig(c.env);
    const url = new URL(c.req.raw.url);
    const challenge = verifyToken(url.searchParams, config.whatsapp.verifyToken);
    if (challenge === null) return c.text("Forbidden", 403);
    return c.text(challenge);
  });

  app.post("/webhook", async (c) => {
    const config = loadConfig(c.env);
    const raw = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");

    if (!(await verifySignature(raw, signature, config.whatsapp.appSecret ?? ""))) {
      return c.text("Forbidden", 403);
    }

    const event = parseInbound(raw);
    if (event === null) {
      // Non-message event (status/read receipt) or malformed payload — acknowledge
      // and ignore so Meta does not retry.
      return c.text("ok");
    }

    const resolved = buildDeps(deps, config, aiBinding(c.env), c.env.DB, c.env.BILLS);
    if (!resolved.ok) {
      return c.text("Service not configured", 503);
    }

    await route(event, resolved.value);
    return c.text("ok");
  });

  return app;
}

/** Resolve injectable deps, falling back to the real adapters; null when not configured. */
function buildDeps(
  deps: AppDeps,
  config: ReturnType<typeof loadConfig>,
  ai?: WorkersAi,
  db?: D1Database,
  bills?: R2Bucket,
):
  | { ok: true; value: RouteDeps }
  | { ok: false } {
  const messenger = deps.send ?? createWhatsAppMessenger(config);
  const users = deps.users ?? (db ? createD1UserStore(db) : undefined);
  const businesses = deps.businesses ?? (db ? createD1BusinessStore(db) : undefined);
  const drafts = deps.drafts ?? (db ? createD1DraftStore(db) : undefined);
  const transactions = deps.transactions ?? (db ? createD1TransactionStore(db) : undefined);
  const extraction = deps.extraction ?? createExtractionService(config, ai);
  const storage = deps.storage ?? (bills ? createR2BillStorage(bills) : undefined);
  if (!messenger || !users || !businesses || !drafts || !transactions || !storage) return { ok: false };
  return {
    ok: true,
    value: { users, businesses, drafts, transactions, extraction, send: messenger, storage, config },
  };
}

// Production entry: fetch + the scheduled nudge/expiry sweep (cron, §5.6/§6.2).
const app = createApp();
// Production entry: fetch + the scheduled nudge/expiry sweep (cron, §5.6/§6.2).
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: async (_event: ScheduledController, env: Env) => {
    const config = loadConfig(env);
    const resolved = buildDeps({}, config, aiBinding(env), env.DB, env.BILLS);
    if (!resolved.ok) return;
    await runSweep(resolved.value);
  },
};

