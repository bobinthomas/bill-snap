/**
 * BillSnap Worker entry point (SCAFFOLDING_PLAN.md §5).
 *
 * Routes:
 * - GET  /webhook  — WhatsApp verify-token handshake (§7.2)
 * - POST /webhook  — X-Hub-Signature-256 verification → parse → route (§5.6)
 * - GET  /health   — skeleton health check (M0)
 * - scheduled    — nudge + expiry sweep (cron, §5.6/§6.2)
 *
 * `createApp` accepts optional dependency overrides (used by tests); the default
 * export builds the production app with the real Supabase/WhatsApp adapters.
 */
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { billsToCsv, dashboardData, exportFileName, renderDashboardPage, seedDemoBills } from "./dev/dashboard";
import { DEMO_MEDIA_ID, demoDeps, demoState, renderDemoPage, setDemoMedia, simulatePhoto, simulateText } from "./dev/demo";
import { createSupabaseBusinessStore, type BusinessStore } from "./db/businesses";
import { createSupabaseDraftStore, type DraftStore } from "./db/drafts";
import { createSupabaseUserStore, type UserStore } from "./db/users";
import { createExtractionService, type ExtractionService } from "./extraction/pipeline";
import type { WorkersAi } from "./extraction/workers-ai";
import { runSweep } from "./flows/nudge";
import { createWhatsAppMessenger, type Messenger } from "./messaging/whatsapp";
import { createSupabaseBillStorage, type BillStorage } from "./storage/bills";
import { parseInbound } from "./webhook/parse";
import { route, type RouteDeps } from "./webhook/router";
import { verifySignature, verifyToken } from "./webhook/verify";

type Env = {
  [key: string]: string | undefined;
};

/** The `env.AI` Workers AI binding, if the runtime provides it (§5.3). */
function aiBinding(env: Env): WorkersAi | undefined {
  return (env as unknown as { AI?: WorkersAi }).AI;
}

export interface AppDeps {
  users?: UserStore;
  businesses?: BusinessStore;
  drafts?: DraftStore;
  extraction?: ExtractionService;
  send?: Messenger;
  storage?: BillStorage;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", (c) => {
    const config = loadConfig(c.env);
    return c.html(renderLanding(config, aiBinding(c.env)));
  });

  // DEV-only browser demo (simulated WhatsApp) — gated on config.devDemo.
  const devDemo = (env: Env) => loadConfig(env).devDemo;
  app.get("/dev/demo", (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    return c.html(renderDemoPage());
  });
  app.get("/dev/demo/state", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    return c.json(await demoState(loadConfig(c.env), aiBinding(c.env)));
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
    await simulatePhoto(config, aiBinding(c.env), fileName, ocrText, configLabel);
    return c.json(await demoState(config, aiBinding(c.env)));
  });
  app.post("/dev/demo/text", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const config = loadConfig(c.env);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "text required" }, 400);
    }
    await simulateText(config, aiBinding(c.env), body.text.trim());
    return c.json(await demoState(config, aiBinding(c.env)));
  });

  // DEV-only analytics dashboard over the demo user's logged bills.
  app.get("/dev/dashboard", (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    return c.html(renderDashboardPage());
  });
  app.get("/dev/dashboard/data", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const q = c.req.query();
    return c.json(
      await dashboardData(loadConfig(c.env), {
        month: q.month || undefined,
        category: q.category || undefined,
        vendor: q.vendor || undefined,
      }),
    );
  });
  app.post("/dev/dashboard/seed", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const config = loadConfig(c.env);
    await seedDemoBills(config);
    return c.json(await dashboardData(config));
  });
  app.get("/dev/dashboard/export.csv", async (c) => {
    if (!devDemo(c.env)) return c.text("Not found", 404);
    const q = c.req.query();
    const filters = {
      month: q.month || undefined,
      category: q.category || undefined,
      vendor: q.vendor || undefined,
    };
    const data = await dashboardData(loadConfig(c.env), filters);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${exportFileName(filters)}"`);
    return c.body(billsToCsv(data.rows));
  });

  app.get("/health", (c) => {
    const config = loadConfig(c.env);
    return c.json({
      status: "ok",
      service: "bill-snap",
      secretsConfigured: {
        whatsapp: Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret),
        workersAi: Boolean(aiBinding(c.env)),
        supabase: Boolean(config.supabase.url && config.supabase.serviceRoleKey),
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

    const resolved = buildDeps(deps, config, aiBinding(c.env));
    if (!resolved.ok) {
      return c.text("Service not configured", 503);
    }

    await route(event, resolved.value);
    return c.text("ok");
  });

  return app;
}

/** Resolve injectable deps, falling back to the real adapters; null when not configured. */
function buildDeps(deps: AppDeps, config: ReturnType<typeof loadConfig>, ai?: WorkersAi):
  | { ok: true; value: RouteDeps }
  | { ok: false } {
  const messenger = deps.send ?? createWhatsAppMessenger(config);
  const users = deps.users ?? createSupabaseUserStore(config);
  const businesses = deps.businesses ?? createSupabaseBusinessStore(config);
  const drafts = deps.drafts ?? createSupabaseDraftStore(config);
  const extraction = deps.extraction ?? createExtractionService(config, ai);
  const storage = deps.storage ?? createSupabaseBillStorage(config);
  if (!messenger || !users || !businesses || !drafts || !storage) return { ok: false };
  return {
    ok: true,
    value: { users, businesses, drafts, extraction, send: messenger, storage, config },
  };
}

/** Minimal landing page so the dev server preview shows real content at `/`. */
function renderLanding(config: ReturnType<typeof loadConfig>, ai?: WorkersAi): string {
  const pill = (name: string, configured: boolean) => `
    <span class="pill ${configured ? "ok" : "missing"}">
      <span class="dot"></span>${name} ${configured ? "configured" : "not configured"}
    </span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — local dev server</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 56px 24px; }
  h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
  .tag { color: #8b949e; font-size: 13px; margin-bottom: 28px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #30363d; border-radius: 999px;
          padding: 4px 12px; font-size: 12px; margin: 0 8px 8px 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .pill.ok .dot { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .pill.missing .dot { background: #f85149; box-shadow: 0 0 6px #f85149; }
  ul { list-style: none; padding: 0; margin: 28px 0 0; border-top: 1px solid #21262d; }
  li { padding: 10px 0; border-bottom: 1px solid #21262d; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { color: #ffa657; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>BillSnap</h1>
    <div class="tag">WhatsApp bill logger — local dev server</div>
    ${pill("WhatsApp webhook", Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret))}
    ${pill("Workers AI", Boolean(ai))}
    ${pill("Supabase", Boolean(config.supabase.url && config.supabase.serviceRoleKey))}
    <ul>
      <li><a href="/dev/demo">/dev/demo</a> — <strong>the browser demo</strong>: drive the bot flow with simulated WhatsApp messages${config.devDemo ? "" : " (enable: set DEV_DEMO=true in .dev.vars)"}</li>
      <li><a href="/dev/dashboard">/dev/dashboard</a> — <strong>the analytics dashboard</strong>: logged bills, spend, GST, categories, vendors${config.devDemo ? "" : " (enable: set DEV_DEMO=true in .dev.vars)"}</li>
      <li><a href="/health">/health</a> — <code>${config.whatsapp.verifyToken ? "live" : "live (secrets missing)"}</code></li>
      <li><a href="/webhook?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=123456">/webhook handshake</a> — echoes the challenge when the verify token matches</li>
      <li><a href="https://github.com" target="_blank" rel="noreferrer">PRD &amp; scaffolding plan</a> — in the repo root</li>
    </ul>
  </div>
</body>
</html>`;
}

// Production entry: fetch + the scheduled nudge/expiry sweep (cron, §5.6/§6.2).
const app = createApp();
// Production entry: fetch + the scheduled nudge/expiry sweep (cron, §5.6/§6.2).
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: async (_event: ScheduledController, env: Env) => {
    const config = loadConfig(env);
    const resolved = buildDeps({}, config, aiBinding(env));
    if (!resolved.ok) return;
    await runSweep(resolved.value);
  },
};

