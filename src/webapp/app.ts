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
  const event: InboundEvent = {
    userPhone: deviceId,
    waMessageId: `web.${deviceId}.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "text",
    text,
  };
  await route(event, webDeps(config, ai, deviceId, bindings));
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
  }>;
}

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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; }
  body { background: #0b141a; color: #e9edef; font-family: -apple-system, Segoe UI, Roboto, sans-serif; display: flex; flex-direction: column; }
  header { padding: calc(12px + env(safe-area-inset-top)) 16px 12px; background: #1f2c34; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header a { color: #00a884; font-size: 13px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  #badge { font-size: 11px; color: #8696a0; width: 100%; }
  main { flex: 1; overflow-y: auto; padding: 16px 16px calc(120px + env(safe-area-inset-bottom)); max-width: 560px; width: 100%; margin: 0 auto; }
  #hero { text-align: center; padding: 28px 0 12px; }
  #hero .big { font-size: 17px; color: #e9edef; margin-bottom: 6px; }
  #hero .sub { font-size: 13px; color: #8696a0; margin-bottom: 20px; }
  .btn { display: block; width: 100%; border: none; border-radius: 14px; padding: 16px; font-size: 17px; font-weight: 700; cursor: pointer; margin: 8px 0; }
  .btn.primary { background: #00a884; color: #0b141a; }
  .btn.ghost { background: #2a3942; color: #e9edef; }
  .btn.danger { background: #3b1d1d; color: #f87171; }
  .btn:disabled { opacity: .5; }
  #preview { width: 100%; max-height: 300px; object-fit: contain; border-radius: 14px; background: #1f2c34; margin: 12px 0; display: none; }
  #status { text-align: center; font-size: 14px; color: #7ee2a8; margin: 12px 0; display: none; }
  #readback { display: none; background: #1f2c34; border: 1px solid #2a3942; border-radius: 14px; padding: 12px 14px; margin: 12px 0; font-size: 13px; }
  #readback .cap { color: #00a884; font-weight: 700; margin-bottom: 6px; }
  #readback .raw { color: #8696a0; white-space: pre-wrap; margin-top: 8px; font-size: 12px; border-top: 1px solid #2a3942; padding-top: 8px; }
  #reply { display: none; background: #123b2c; border: 1px solid #00a884; color: #e9edef; border-radius: 14px; padding: 12px 14px; margin: 12px 0; font-size: 14px; white-space: pre-wrap; }
  #reply.error { background: #3b1d1d; border-color: #f87171; }
  .card { background: #1f2c34; border-radius: 16px; padding: 16px; margin: 12px 0; }
  .card h2 { font-size: 14px; color: #8696a0; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #2a3942; font-size: 15px; }
  .row:last-child { border-bottom: none; }
  .row .k { color: #8696a0; font-size: 13px; }
  .row .v { font-weight: 600; text-align: right; }
  .row .v.missing { color: #f0c36d; font-weight: 400; }
  .row .v.warn { color: #f0c36d; }
  .row .edit { background: #2a3942; color: #e9edef; border: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; margin-left: 10px; cursor: pointer; }
  .row .amount { font-size: 22px; font-weight: 800; color: #00a884; }
  #editbox { display: none; margin: 12px 0; }
  #editbox input { width: 100%; background: #2a3942; color: #e9edef; border: none; border-radius: 12px; padding: 14px; font-size: 16px; margin-bottom: 8px; }
  #editbox input:focus { outline: 1px solid #00a884; }
  h3 { font-size: 13px; color: #8696a0; text-transform: uppercase; letter-spacing: .04em; margin: 20px 0 8px; }
  #recent { margin: 0; padding: 0; list-style: none; }
  #recent li { display: flex; justify-content: space-between; align-items: center; padding: 10px 4px; border-bottom: 1px solid #2a3942; font-size: 14px; }
  #recent .amt { font-weight: 700; }
  #recent .who { color: #8696a0; font-size: 12px; }
  .empty { color: #8696a0; font-size: 13px; padding: 8px 0; }
  #actions { position: fixed; bottom: 0; left: 0; right: 0; background: #0b141a; border-top: 1px solid #2a3942; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); display: none; max-width: 560px; margin: 0 auto; }
  #actions .btn { margin: 4px 0; }
  code { color: #ffa657; }
</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
  <header>
    <h1>BillSnap</h1>
    <a href="/dev/dashboard?device=" class="dash-link">📊 Dashboard</a>
    <span id="badge"></span>
  </header>
  <main>
    <div id="hero">
      <div class="big">📸 Snap a bill</div>
      <div class="sub">Take a photo of any bill or invoice — I'll read the amount, date, vendor, and GST, and you confirm.</div>
      <button class="btn primary" id="camera">📷 Take photo</button>
      <button class="btn ghost" id="gallery">🖼 Choose from gallery</button>
      <button class="btn ghost" id="sample">🧾 Sample bill</button>
    </div>
    <input type="file" id="file" accept="image/*" hidden />
    <img id="preview" alt="bill preview" />
    <div id="status">🔍 Reading…</div>
    <div id="readback"></div>
    <div id="reply"></div>
    <div id="draft"></div>
    <div id="editbox">
      <input id="editvalue" placeholder="Value…" />
      <button class="btn primary" id="editsave">Save</button>
      <button class="btn ghost" id="editcancel">Cancel</button>
    </div>
    <h3>Recent bills</h3>
    <ul id="recent"></ul>
  </main>
  <div id="actions"></div>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n === null ? "Not found" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  async function refresh() {
    const res = await fetch("/app/state?device=" + encodeURIComponent(device));
    if (res.ok) render(await res.json());
  }

  function render(s) {
    $("badge").textContent = "persistence: " + s.persistence + " · extractor: " + s.extractor +
      (s.recent.length ? " · " + s.recent.length + " logged" : "");
    const reply = $("reply");
    if (s.lastReply && s.draft === null) {
      reply.style.display = "block";
      reply.textContent = s.lastReply;
      reply.className = /undo|Undone|Skipped|Logged|Welcome/i.test(s.lastReply) ? "" : "error";
    } else {
      reply.style.display = "none";
    }
    const read = $("readback");
    if (s.ocrRead) {
      read.style.display = "block";
      const raw = s.ocrRead.ocrText.split(/\\r?\\n/).map((l) => l.trim()).filter((l) => l !== "").join("\\n");
      read.innerHTML = '<div class="cap">🔎 OCR read' + (s.ocrRead.config ? " — " + esc(s.ocrRead.config) : "") + "</div>" +
        "Amount: <strong>" + (s.ocrRead.amount === null ? "not found" : "$" + s.ocrRead.amount.toFixed(2)) + "</strong>" +
        (s.ocrRead.amountLine ? ' <span style="color:#8696a0">(from line "' + esc(s.ocrRead.amountLine) + '")</span>' : "") + "<br/>" +
        "Date: " + (s.ocrRead.date ?? "not found") + "<br/>" +
        "Vendor: " + (s.ocrRead.vendor ?? "not found") +
        '<div class="raw">' + esc(raw) + "</div>";
    } else {
      read.style.display = "none";
    }
    renderDraft(s.draft);
    const recent = $("recent");
    if (!s.recent.length) {
      recent.innerHTML = '<li class="empty">Nothing logged yet.</li>';
    } else {
      recent.innerHTML = s.recent.map((b) =>
        '<li><span>' + esc(b.vendor || "—") + '<div class="who">' + (b.category || "") + " · " + b.confirmedAt.slice(0, 10) + "</div></span>" +
        '<span class="amt">' + money(b.amount) + "</span></li>"
      ).join("");
    }
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
    const flag = d.machineRead ? "⚠️ Machine-read, please verify" : d.gateLevel === "high" ? "✅ High confidence" : "⚠️ Check details";
    const missing = '<span class="v missing">Not found — edit to add</span>';
    const row = (k, v, warn, editAction) =>
      '<div class="row"><span class="k">' + k + '</span><span class="v' + (warn ? " warn" : "") + '">' + v +
      (editAction ? '<button class="edit" onclick="' + editAction + '">✏️</button>' : "") + "</span></div>";
    const amountCell = e.amount === null
      ? missing
      : '<span class="v amount">' + money(e.amount) + '</span><button class="edit" onclick="act(\\'2\\')">✏️</button>';
    wrap.innerHTML = '<div class="card"><h2>📄 ' + esc(flag) + "</h2>" +
      '<div class="row"><span class="k">Amount</span><span>' + amountCell + "</span></div>" +
      row("Vendor", e.vendor === null ? "Not found — edit to add" : esc(e.vendor), false, "act('3')") +
      row("Date", e.date === null ? "Not found — edit to add" : esc(e.date), false, "act('5')") +
      row("ABN", e.abn === null ? "Not verified" : esc(e.abn), false, null) +
      row("GST", e.gst === null ? "—" : money(e.gst), false, null) +
      "</div>";
    actions.style.display = "block";
    actions.innerHTML =
      '<button class="btn primary" onclick="act(\\'1\\')">✅ Confirm & Save</button>' +
      '<button class="btn danger" onclick="act(\\'4\\')">🗑 Skip / Wrong bill</button>' +
      '<button class="btn ghost" onclick="act(\\'delete\\')">↩️ Undo last</button>';
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
    $("status").style.display = "block";
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
  $("sample").onclick = () => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 400;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 36px sans-serif"; ctx.fillText("Origin Energy", 40, 64);
    ctx.font = "26px sans-serif";
    ctx.fillText("Electricity account", 40, 102);
    ctx.fillText("10/08/2026", 40, 140);
    ctx.fillText("Subtotal: $243.00", 40, 196);
    ctx.fillText("GST: $24.30", 40, 234);
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("Total:", 40, 290);
    ctx.fillText("$267.30", 40, 328);
    c.toBlob((blob) => {
      if (blob) sendBill(new File([blob], "sample-bill.png", { type: "image/png" }), "sample-bill.png", false);
    }, "image/png");
  };
  $("editsave").onclick = () => {
    const v = $("editvalue").value.trim();
    if (v) { act(v); $("editvalue").value = ""; }
  };
  $("editcancel").onclick = () => { $("editbox").style.display = "none"; refresh(); };
  $("editvalue").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("editsave").click(); });
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`;

export function renderWebAppPage(): string {
  return WEB_APP_PAGE;
}
