/**
 * /app — the mobile-first webapp (the new primary flow; the WhatsApp flow is
 * on hold). The user uploads a photo in the browser; everything downstream is
 * the SAME pipeline as WhatsApp: onboarding (§4.5 auto-create), the photo flow
 * (draft + extraction + gating), the confirm/edit screens (§6.2/§6.3), logging,
 * and the undo window.
 *
 * Identity: a browser-generated device id acts as `userPhone` — the stores,
 * router, and flows are identity-agnostic, so the whole §5.6 pipeline runs
 * unchanged. Unknown devices auto-onboard exactly like unknown WhatsApp numbers.
 *
 * Persistence: the real D1 + R2 stores when the bindings are present, otherwise
 * an in-memory singleton (module scope keeps multi-turn state alive across
 * requests). Everything stays inside Cloudflare (§5.5).
 */
import type { AppConfig } from "../config";
import type { CloudBindings } from "../bindings";
import { createD1BusinessStore, type BusinessStore } from "../db/businesses";
import { createD1DraftStore, type DraftStore } from "../db/drafts";
import { createD1UserStore, type UserStore } from "../db/users";
import { createExtractionService, type ExtractionOutcome, type ExtractionService } from "../extraction/pipeline";
import { mergeKnownVendors } from "../extraction/regex";
import type { WorkersAi } from "../extraction/workers-ai";
import type { DownloadedMedia, Messenger } from "../messaging/whatsapp";
import { createR2BillStorage, type BillStorage } from "../storage/bills";
import type { InboundEvent } from "../types";
import { route, type RouteDeps } from "../webhook/router";
import { getSharedMemoryStack, resetSharedMemoryStack } from "../dev/memory";
import {
  iconAlertTriangle,
  iconBarChart,
  iconCamera,
  iconCheckCircle,
  iconImage,
  iconPencil,
  iconRefresh,
  iconUndo,
  iconXCircle,
} from "../dev/icons";
import { BASE_STYLES } from "../dev/theme";

/** Per-device bot messages (the UI shows the latest as a banner/toast). */
const replies = new Map<string, string[]>();
/** Stashed uploaded image bytes per media id (the photo flow downloads them). */
const mediaStash = new Map<string, { bytes: Uint8Array; mimeType: string; fileName: string }>();
/** Per-device OCR read-back (raw lines + captured amount/date), like the demo. */
const ocrReads = new Map<string, OcrRead>();

interface OcrRead {
  ocrText: string;
  amount: number | null;
  vendor: string | null;
  date: string | null;
  amountLine: string | null;
  config?: string;
}

class WebMessenger implements Messenger {
  constructor(private readonly deviceId: string) {}

  async sendText(_to: string, text: string): Promise<void> {
    const list = replies.get(this.deviceId) ?? [];
    list.push(text);
    replies.set(this.deviceId, list);
  }

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const stored = mediaStash.get(mediaId);
    if (stored) return { bytes: stored.bytes, mimeType: stored.mimeType };
    return { bytes: new TextEncoder().encode("bill-snap-web-image"), mimeType: "image/jpeg" };
  }
}

/** The raw line that carries the extracted amount ("$267.30"), when visible. */
function amountLineOf(ocrText: string, amount: number | null): string | null {
  if (amount === null) return null;
  const needle = amount.toFixed(2);
  for (const line of ocrText.split(/\r?\n/)) {
    const t = line.trim();
    if (t.includes(needle) || t.includes(String(amount))) return t;
  }
  return null;
}

/** Webapp deps: real D1 + R2 stores when the bindings are present, else the in-memory stack. */
export function webDeps(
  config: AppConfig,
  ai: WorkersAi | undefined,
  deviceId: string,
  bindings?: CloudBindings,
): RouteDeps {
  const memory = getSharedMemoryStack();
  const users: UserStore = bindings?.db ? createD1UserStore(bindings.db) : memory.users;
  const businesses: BusinessStore = bindings?.db ? createD1BusinessStore(bindings.db) : memory.businesses;
  const drafts: DraftStore = bindings?.db ? createD1DraftStore(bindings.db) : memory.drafts;
  const storage: BillStorage = bindings?.bills ? createR2BillStorage(bindings.bills) : memory.storage;
  const inner = createExtractionService(config, ai);
  return {
    users,
    businesses,
    drafts,
    extraction: {
      async run(input) {
        // Grow the known-vendor list from the business's own logged bills
        // (learned merchants) so a mangled re-read of a familiar store is
        // canonicalised — the extraction layer itself stays stateless.
        const logged = await drafts.listLogged(deviceId, 200);
        const learned = logged.map((d) => d.extraction?.vendor.value ?? null);
        const outcome = await inner.run({ ...input, knownVendors: mergeKnownVendors(learned) });
        if (input.ocrText && input.ocrText.trim() !== "") {
          ocrReads.set(deviceId, {
            ocrText: input.ocrText,
            amount: outcome.extraction.amount.value,
            vendor: outcome.extraction.vendor.value,
            date: outcome.extraction.date.value,
            amountLine: amountLineOf(input.ocrText, outcome.extraction.amount.value),
            config: lastOcrConfig.get(deviceId) ?? undefined,
          });
        }
        return outcome;
      },
    },
    send: new WebMessenger(deviceId),
    storage,
    config,
  };
}

const lastOcrConfig = new Map<string, string | null>();

/** Stash uploaded image bytes so the photo flow's downloadMedia finds them. */
export function stashWebMedia(
  deviceId: string,
  media: { bytes: Uint8Array; mimeType: string; fileName: string },
): string {
  const mediaId = `web-${deviceId}-${Date.now()}`;
  mediaStash.set(mediaId, media);
  return mediaId;
}

export async function webPhoto(
  config: AppConfig,
  ai: WorkersAi | undefined,
  deviceId: string,
  mediaId: string | null,
  fileName?: string,
  ocrText?: string,
  ocrConfig?: string,
  bindings?: CloudBindings,
): Promise<void> {
  lastOcrConfig.set(deviceId, ocrConfig ?? null);
  const event: InboundEvent = {
    userPhone: deviceId,
    waMessageId: `web.${deviceId}.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "photo",
    imageUrls: mediaId ? [mediaId] : [],
    ocrText,
  };
  if (fileName) {
    const list = replies.get(deviceId) ?? [];
    list.push(`📷 (photo: ${fileName})`);
    replies.set(deviceId, list);
  }
  await route(event, webDeps(config, ai, deviceId, bindings));
}

export async function webAction(
  config: AppConfig,
  ai: WorkersAi | undefined,
  deviceId: string,
  text: string,
  bindings?: CloudBindings,
): Promise<void> {
  if (text.startsWith("delete:")) {
    await webDelete(config, ai, deviceId, text.slice("delete:".length), bindings);
    return;
  }
  const event: InboundEvent = {
    userPhone: deviceId,
    waMessageId: `web.${deviceId}.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "text",
    text,
  };
  await route(event, webDeps(config, ai, deviceId, bindings));
}

async function webDelete(
  config: AppConfig,
  ai: WorkersAi | undefined,
  deviceId: string,
  billId: string,
  bindings?: CloudBindings,
): Promise<void> {
  const deps = webDeps(config, ai, deviceId, bindings);
  const bill = (await deps.drafts.listLogged(deviceId, 20)).find((entry) => entry.id === billId);
  const cutoff = Date.now() - WEB_DELETE_WINDOW_MS;
  if (!bill?.confirmedAt || bill.confirmedAt.getTime() < cutoff) {
    const list = replies.get(deviceId) ?? [];
    list.push("Delete window expired.");
    replies.set(deviceId, list);
    return;
  }
  await deps.drafts.softDeleteLogged(bill.id);
  const list = replies.get(deviceId) ?? [];
  list.push("Deleted from recent bills.");
  replies.set(deviceId, list);
}

export interface WebDraftState {
  id: string;
  flowState: string | null;
  status: string;
  gateLevel?: string;
  machineRead?: boolean;
  extraction?: {
    amount: number | null;
    date: string | null;
    vendor: string | null;
    vendorResolvedTo: string | null;
    abn: string | null;
    gst: number | null;
    gstBasis: string;
    invoiceNumber: string | null;
  } | null;
}

export interface WebAppState {
  deviceId: string;
  persistence: "d1" | "in-memory";
  /** Which extractor reads uploaded photos — "mock" is CANNED, never a real read. */
  extractor: string;
  /** Latest bot reply (welcome, confirm screen, logged, undone, prompts). */
  lastReply: string | null;
  /** The most recent photo's OCR read-back (raw lines + captured fields). */
  ocrRead: OcrRead | null;
  /** §5.8 auto-log opt-out — off forces every bill onto the confirm screen. */
  autoSave: boolean;
  draft: WebDraftState | null;
  recent: Array<{
    id: string;
    confirmedAt: string;
    amount: number | null;
    vendor: string | null;
    /** The known vendor a mangled reading was canonicalised to, when it was. */
    vendorResolvedTo: string | null;
    category: string;
    gst: number | null;
    autoLogged: boolean;
    deleteUntil: string;
  }>;
}

const WEB_DELETE_WINDOW_MS = 2 * 60 * 60_000;

export async function webAppState(
  config: AppConfig,
  ai?: WorkersAi,
  deviceId?: string,
  bindings?: CloudBindings,
): Promise<WebAppState> {
  const id = deviceId ?? "web_unknown";
  const deps = webDeps(config, ai, id, bindings);
  const draft = await deps.drafts.findActiveDraft(id);
  const recent = await deps.drafts.listLogged(id, 20);
  const list = replies.get(id) ?? [];
  const user = await deps.users.findUser(id);
  const business = user?.businessId ? await deps.businesses.findBusiness(user.businessId) : null;
  return {
    deviceId: id,
    persistence: bindings?.db ? "d1" : "in-memory",
    extractor: config.geminiMock
      ? "mock (canned)"
      : ai
        ? "Workers AI + local OCR fallback"
        : "local OCR",
    lastReply: list.length > 0 ? list[list.length - 1]! : null,
    ocrRead: ocrReads.get(id) ?? null,
    autoSave: business?.autoSave ?? true,
    draft: draft
      ? {
          id: draft.id,
          flowState: draft.flowState,
          status: draft.status,
          gateLevel: draft.gateLevel,
          machineRead: draft.machineRead,
          extraction: draft.extraction
            ? {
                amount: draft.extraction.amount.value,
                date: draft.extraction.date.value,
                vendor: draft.extraction.vendor.value,
                vendorResolvedTo: draft.extraction.vendor_resolved_to?.value ?? null,
                abn: draft.extraction.abn.value,
                gst: draft.extraction.gst.value,
                gstBasis: draft.extraction.gst_basis,
                invoiceNumber: draft.extraction.invoice_number.value,
              }
            : null,
        }
      : null,
    recent: recent.map((b) => ({
      id: b.id,
      confirmedAt: (b.confirmedAt ?? b.createdAt).toISOString(),
      amount: b.extraction?.amount.value ?? null,
      vendor: b.extraction?.vendor.value ?? null,
      vendorResolvedTo: b.extraction?.vendor_resolved_to?.value ?? null,
      category: b.extraction?.category_hint?.value ?? "misc",
      gst: b.extraction?.gst.value ?? null,
      autoLogged: b.autoLogged ?? false,
      deleteUntil: new Date((b.confirmedAt ?? b.createdAt).getTime() + WEB_DELETE_WINDOW_MS).toISOString(),
    })),
  };
}

/** Test helper: clear the shared in-memory stack, replies, media, and OCR reads. */
export function resetWebApp(): void {
  resetSharedMemoryStack();
  replies.clear();
  mediaStash.clear();
  ocrReads.clear();
  lastOcrConfig.clear();
}

/**
 * The mobile-first webapp page. Self-contained (inline CSS/JS): a big
 * camera/upload button, in-browser OCR (tesseract.js), the read-back above the
 * confirm card, edit taps per field, Confirm & Save / Skip / Undo, and the
 * device's recent logged bills.
 */
const WEB_APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>BillSnap</title>
<style>
${BASE_STYLES}
  * { -webkit-tap-highlight-color: transparent; }
  body { height: 100dvh; display: flex; flex-direction: column; }
  .topbar { padding-top: calc(10px + env(safe-area-inset-top)); }
  .autosave-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim);
    font-size: 12px; font-weight: 600; padding: 5px 10px 5px 8px; border-radius: var(--radius-pill);
    cursor: pointer; font-family: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease;
  }
  .autosave-toggle .icon { width: 14px; height: 14px; }
  .autosave-toggle.on { background: var(--success-soft); border-color: var(--success-border); color: var(--success-text); }
  .autosave-toggle.off { background: var(--surface-2); border-color: var(--border); color: var(--text-faint); }
  main { flex: 1; overflow-y: auto; padding: 16px 16px calc(132px + env(safe-area-inset-bottom)); max-width: 560px; width: 100%; margin: 0 auto; }
  #hero { text-align: center; padding: 20px 0 8px; }
  .hero-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: var(--radius-lg);
    background: var(--accent-soft); color: var(--accent-text); border: 1px solid var(--accent-border);
    margin-bottom: 14px;
  }
  .hero-icon .icon { width: 26px; height: 26px; }
  #hero .big { font-size: 19px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
  #hero .sub { font-size: 13.5px; color: var(--text-faint); line-height: 1.5; margin-bottom: 20px; max-width: 44ch; margin-left: auto; margin-right: auto; }
  #hero { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 8px; }
  #hero .hero-icon, #hero .big, #hero .sub { grid-column: 1 / -1; }
  #hero .btn-lg { width: 100%; margin: 7px 0; padding: 13px 8px; font-size: 13px; }
  .btn-lg {
    display: flex; align-items: center; justify-content: center; gap: 9px;
    width: 100%; border: 1px solid transparent; border-radius: var(--radius-md);
    padding: 15px 16px; font-size: 16px; font-weight: 700; font-family: inherit;
    cursor: pointer; margin: 7px 0;
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.08s ease, opacity 0.15s ease;
  }
  .btn-lg:active { transform: translateY(1px); }
  .btn-lg:disabled { opacity: .5; cursor: not-allowed; }
  .btn-lg .icon { width: 19px; height: 19px; }
  .btn-lg.primary { background: var(--accent-solid); color: #fff; }
  .btn-lg.primary:hover { background: var(--accent-solid-hover); }
  .btn-lg.ghost { background: var(--surface-2); color: var(--text); border-color: var(--border); }
  .btn-lg.ghost:hover { background: var(--surface-3); }
  #preview { width: 100%; max-height: 280px; object-fit: contain; border-radius: var(--radius-md); background: var(--surface); border: 1px solid var(--border); margin: 12px 0; display: none; }
  #status {
    display: none; align-items: center; justify-content: center; gap: 8px;
    text-align: center; font-size: 13.5px; color: var(--text-dim); margin: 12px 0;
  }
  #status .icon { width: 16px; height: 16px; }
  @media (prefers-reduced-motion: no-preference) {
    #status .icon { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  }
  #reply { display: none; }
  .confidence-badge { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 700; margin-bottom: 12px; }
  .confidence-badge .icon { width: 17px; height: 17px; flex: none; }
  .confidence-badge.ok { color: var(--success-text); }
  .confidence-badge.warn { color: var(--warn-text); }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border-soft); font-size: 15px; gap: 10px; }
  .row:last-child { border-bottom: none; }
  .row .k { color: var(--text-faint); font-size: 13px; flex: none; }
  .row .v { font-weight: 600; text-align: right; display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
  .row .v.missing { color: var(--warn-text); font-weight: 400; font-size: 13px; }
  .row .amount { font-size: 24px; font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; }
  .edit-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; flex: none;
    background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border);
    border-radius: var(--radius-sm); cursor: pointer;
  }
  .edit-btn .icon { width: 14px; height: 14px; }
  #editbox { display: none; margin: 12px 0; }
  #editbox input.text-input { width: 100%; padding: 14px; font-size: 16px; margin-bottom: 8px; }
  h3 { font-size: 11.5px; color: var(--text-faint); text-transform: uppercase; letter-spacing: .05em; font-weight: 700; margin: 22px 0 8px; }
  #recent { margin: 0; padding: 0; list-style: none; }
  #recent li { display: flex; justify-content: space-between; align-items: center; padding: 11px 2px; border-bottom: 1px solid var(--border-soft); font-size: 14px; gap: 10px; }
  #recent li:last-child { border-bottom: none; }
  #recent .amt { font-weight: 700; font-variant-numeric: tabular-nums; }
  #recent .who { color: var(--text-faint); font-size: 11.5px; margin-top: 1px; }
  #recent .recent-main { min-width: 0; }
  #recent .recent-actions { display: flex; align-items: center; gap: 8px; flex: none; }
  #recent .delete-btn { padding: 6px 9px; margin: 0; width: auto; font-size: 11.5px; font-weight: 600; border-radius: var(--radius-sm); }
  #actions {
    position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface);
    border-top: 1px solid var(--border); padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
    display: none; max-width: 560px; margin: 0 auto;
  }
  #actions { display: none; gap: 8px; }
  #actions .btn-lg { flex: 1 1 0; min-width: 0; margin: 5px 0; padding-left: 8px; padding-right: 8px; font-size: 13px; }
  @media (max-width: 390px) { #actions { flex-wrap: wrap; } #actions .btn-lg { flex-basis: 100%; } }
  @media (max-width: 350px) { #hero { display: block; } #hero .btn-lg { width: 100%; } }
</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconCamera}</span>
      <div class="brand-title">BillSnap</div>
    </div>
    <div class="topbar-status">
      <a href="/dev/dashboard?device=" class="nav-link dash-link">${iconBarChart} Dashboard</a>
      <button id="autosaveToggle" class="autosave-toggle" title="High-confidence AI reads auto-log with a 24h undo when on; every bill needs Confirm &amp; Save when off"></button>
    </div>
  </header>
  <main>
    <div id="hero">
      <span class="hero-icon">${iconCamera}</span>
      <div class="big">Snap a bill</div>
      <div class="sub">Take a photo of any bill or invoice — I'll read the amount, date, vendor, and GST, and you confirm.</div>
      <button class="btn-lg primary" id="camera">${iconCamera}<span>Take photo</span></button>
      <button class="btn-lg ghost" id="gallery">${iconImage}<span>Choose from gallery</span></button>
    </div>
    <input type="file" id="file" accept="image/*" hidden />
    <img id="preview" alt="bill preview" />
    <div id="status">${iconRefresh}<span>Reading…</span></div>
    <div id="reply" class="notice"></div>
    <div id="draft"></div>
    <div id="editbox">
      <input id="editvalue" class="text-input" placeholder="Value…" />
      <button class="btn-lg primary" id="editsave">Save</button>
      <button class="btn-lg ghost" id="editcancel">Cancel</button>
    </div>
    <h3>Recent bills</h3>
    <ul id="recent"></ul>
    <div id="badge" hidden></div>
  </main>
  <div id="actions"></div>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n === null ? "Not found" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ICON_CHECK = '${iconCheckCircle}';
  const ICON_WARN = '${iconAlertTriangle}';
  const ICON_CROSS = '${iconXCircle}';
  const ICON_PENCIL = '${iconPencil}';
  const ICON_UNDO = '${iconUndo}';

  // Device identity: a stable browser id acts as the userPhone the router keys on.
  let device = localStorage.getItem("billsnap.device");
  if (!device) {
    device = "web_" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    localStorage.setItem("billsnap.device", device);
  }
  document.querySelector(".dash-link").href = "/dev/dashboard?device=" + encodeURIComponent(device);

  const OCR_CONFIGS = [
    { name: "default", opts: {} },
    { name: "sparse (PSM 6)", opts: { tessedit_pageseg_mode: "6" } },
    {
      name: "digits+labels",
      opts: {
        tessedit_pageseg_mode: "6",
        tessedit_char_whitelist: "0123456789$.,/-:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
      },
    },
  ];
  let ocrIndex = 0;
  let lastFile = null;
  let lastName = "";
  let editing = false;
  let autoSave = true;

  async function refresh() {
    const res = await fetch("/app/state?device=" + encodeURIComponent(device));
    if (res.ok) render(await res.json());
  }

  $("autosaveToggle").onclick = () => act(autoSave ? "autosave off" : "autosave on");

  function chip(text, variant) {
    const cls = "chip" + (variant ? " chip-" + variant : "");
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }

  function render(s) {
    autoSave = s.autoSave;
    const toggle = $("autosaveToggle");
    toggle.innerHTML = (autoSave ? ICON_CHECK : ICON_CROSS) + "<span>Auto-save " + (autoSave ? "on" : "off") + "</span>";
    toggle.className = "autosave-toggle " + (autoSave ? "on" : "off");
    $("badge").innerHTML = chip(s.persistence) + chip(s.extractor) + (s.recent.length ? chip(s.recent.length + " logged", "accent") : "");
    const reply = $("reply");
    if (s.lastReply && s.draft === null) {
      const ok = /undo|Undone|Skipped|Logged|Welcome/i.test(s.lastReply);
      reply.style.display = "flex";
      reply.className = "notice " + (ok ? "notice-success" : "notice-warn");
      reply.innerHTML = '<span class="notice-icon">' + (ok ? ICON_CHECK : ICON_WARN) + "</span><span>" + esc(s.lastReply) + "</span>";
    } else {
      reply.style.display = "none";
    }
    renderDraft(s.draft);
    const recent = $("recent");
    if (!s.recent.length) {
      recent.innerHTML = '<li class="empty">Nothing logged yet.</li>';
    } else {
      recent.innerHTML = s.recent.map((b) =>
        '<li><span class="recent-main"><strong>' + esc(b.vendor || "—") + '</strong><div class="who">' + esc(b.category || "") + " · " + b.confirmedAt.slice(0, 10) + "</div></span>" +
        '<span class="recent-actions"><span class="amt">' + money(b.amount) + '</span><button class="btn-lg ghost delete-btn" data-delete-id="' + esc(b.id) + '" onclick="deleteBill(this.dataset.deleteId)">Delete · <span class="delete-countdown" data-until="' + esc(b.deleteUntil) + '">2 hrs</span></button></span></li>'
      ).join("");
      updateDeleteCountdowns();
    }
  }

  function deleteBill(id) { act("delete:" + id); }

  function updateDeleteCountdowns() {
    document.querySelectorAll(".delete-countdown").forEach((el) => {
      const remaining = new Date(el.dataset.until).getTime() - Date.now();
      if (remaining <= 0) {
        el.closest("button").remove();
        return;
      }
      const minutes = Math.ceil(remaining / 60000);
      el.textContent = minutes >= 60 ? Math.ceil(minutes / 60) + " hrs" : minutes + " min";
    });
  }

  function renderDraft(d) {
    const wrap = $("draft");
    const actions = $("actions");
    if (!d) {
      wrap.innerHTML = "";
      actions.style.display = "none";
      editing = false;
      $("editbox").style.display = "none";
      return;
    }
    if (d.flowState && d.flowState.startsWith("editing_")) {
      wrap.innerHTML = "";
      actions.style.display = "none";
      editing = true;
      $("editbox").style.display = "block";
      $("editvalue").focus();
      return;
    }
    editing = false;
    $("editbox").style.display = "none";
    const e = d.extraction || {};
    const flagOk = !d.machineRead && d.gateLevel === "high";
    const flagIcon = flagOk ? ICON_CHECK : ICON_WARN;
    const flagText = d.machineRead ? "Machine-read, please verify" : flagOk ? "High confidence" : "Check details";
    const missing = '<span class="v missing">Not found — edit to add</span>';
    const editBtn = (action) => '<button class="edit-btn" onclick="' + action + '">' + ICON_PENCIL + "</button>";
    const row = (k, v, editAction) =>
      '<div class="row"><span class="k">' + k + '</span><span class="v">' + v +
      (editAction ? editBtn(editAction) : "") + "</span></div>";
    const amountCell = e.amount === null
      ? missing
      : '<span class="v amount">' + money(e.amount) + "</span>" + editBtn("act('2')");
    wrap.innerHTML = '<div class="panel"><div class="confidence-badge ' + (flagOk ? "ok" : "warn") + '">' + flagIcon + "<span>" + esc(flagText) + "</span></div>" +
      '<div class="row"><span class="k">Amount</span><span>' + amountCell + "</span></div>" +
      row("Vendor", e.vendor === null ? "Not found — edit to add" : esc(e.vendor), "act('3')") +
      row("Date", e.date === null ? "Not found — edit to add" : esc(e.date), "act('5')") +
      row("ABN", e.abn === null ? "Not verified" : esc(e.abn), null) +
      row("GST", e.gst === null ? "—" : money(e.gst), null) +
      "</div>";
    actions.style.display = "flex";
    actions.innerHTML =
      '<button class="btn-lg primary" onclick="act(\\'1\\')">' + ICON_CHECK + "<span>Confirm &amp; Save</span></button>" +
      '<button class="btn-lg ghost" onclick="act(\\'4\\')">' + ICON_CROSS + "<span>Skip / Wrong bill</span></button>" +
      '<button class="btn-lg ghost" onclick="act(\\'delete\\')">' + ICON_UNDO + "<span>Undo last</span></button>";
  }

  async function act(text) {
    await fetch("/app/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, text }),
    });
    await refresh();
  }

  // Preprocess a photo for OCR: upscale small images and binarize with Otsu
  // thresholding. Phone-compressed photos (e.g. a 232x299 JPEG) OCR as garbage
  // raw; upscaling + binarization turns them into clean text (verified: the
  // HDFC receipt reads "AMOUNT Rs 321.68" only after preprocessing).
  async function preprocessForOcr(f) {
    const url = URL.createObjectURL(f);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    // Upscale to ~1200px on the long side (cap 4x to bound work on big photos).
    const target = 1200;
    const scale = Math.min(4, Math.max(1, target / Math.max(w, h)));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    // Grayscale + Otsu threshold (max between-class variance).
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    const gray = new Uint8Array(px.length / 4);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      gray[j] = g; hist[g]++;
    }
    const total = gray.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, otsu = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; otsu = t; }
    }
    // Photos of receipts on textured backgrounds (wood, tables) skew the
    // histogram, so raw Otsu lands too high and washes out faint digits.
    // Bias it down toward the text/paper split (~0.75x, clamped) — verified:
    // this HDFC receipt reads "AMOUNT Rs 321.68" only with the biased
    // threshold; 0.8x lands at 113 where the TOTAL line reads "48".
    const thr = Math.max(90, Math.min(170, Math.round(otsu * 0.75)));
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = gray[j] > thr ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return { blob, scale, threshold: thr };
  }

  // Photo upload: browser OCR (tesseract) → send bytes + text → the pipeline.
  async function sendBill(f, name, retry) {
    lastFile = f;
    lastName = name;
    if (!retry) {
      const url = URL.createObjectURL(f);
      const img = $("preview");
      img.src = url;
      img.style.display = "block";
    }
    const cfg = OCR_CONFIGS[ocrIndex % OCR_CONFIGS.length];
    $("status").style.display = "flex";
    let ocrText = "";
    let prep = null;
    try {
      if (window.Tesseract) {
        prep = await preprocessForOcr(f);
        const res = await window.Tesseract.recognize(prep.blob, "eng", cfg.opts);
        ocrText = (res && res.data && res.data.text) || "";
      }
    } catch (e) { /* OCR unavailable — send bytes without text */ }
    const fd = new FormData();
    fd.append("device", device);
    fd.append("file", f);
    if (ocrText.trim()) fd.append("ocrText", ocrText);
    const prepLabel = prep ? "preprocess " + prep.scale + "x/@" + prep.threshold : null;
    const label = cfg.name !== "default" ? cfg.name : null;
    if (label || prepLabel) fd.append("ocrConfig", [label, prepLabel].filter(Boolean).join(" · "));
    await fetch("/app/photo", { method: "POST", body: fd });
    ocrIndex++;
    $("status").style.display = "none";
    $("file").value = "";
    await refresh();
  }

  const fileInput = $("file");
  $("camera").onclick = () => { fileInput.setAttribute("capture", "environment"); fileInput.click(); };
  $("gallery").onclick = () => { fileInput.removeAttribute("capture"); fileInput.click(); };
  fileInput.onchange = () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) sendBill(f, f.name, false);
  };
  $("editsave").onclick = () => {
    const v = $("editvalue").value.trim();
    if (v) { act(v); $("editvalue").value = ""; }
  };
  $("editcancel").onclick = () => { $("editbox").style.display = "none"; refresh(); };
  $("editvalue").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("editsave").click(); });
  refresh();
  setInterval(refresh, 3000);
  setInterval(updateDeleteCountdowns, 60000);
</script>
</body>
</html>`;

export function renderWebAppPage(): string {
  return WEB_APP_PAGE;
}
