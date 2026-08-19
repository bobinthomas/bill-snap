/**
 * /dev/demo — a browser console that drives the REAL routing pipeline with
 * simulated WhatsApp messages (DEV-only, gated by config.devDemo; never in
 * production). No Meta, no phone: the demo messenger records what the bot
 * would have sent and serves fixture image bytes for the media download.
 *
 * Persistence: the real D1 + R2 stores when the bindings are present, otherwise
 * an in-memory singleton (module scope keeps multi-turn state alive across HTTP
 * requests inside the dev isolate). Everything stays inside Cloudflare (§5.5).
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
import { iconAlertTriangle, iconBarChart, iconCamera, iconHelp, iconMessageCircle, iconReceipt, iconRefresh, iconSearch, iconSend, iconTrash } from "./icons";
import { getSharedMemoryStack, resetSharedMemoryStack } from "./memory";
import { BASE_STYLES } from "./theme";

export const DEMO_PHONE = "61400000111";
export const DEMO_MEDIA_ID = "DEMO-MEDIA";

export interface DemoMessage {
  from: "user" | "bot";
  text: string;
}

export interface StoredDemoMedia {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

const messages: DemoMessage[] = [];
/** Source of the most recent photo extraction — shown in the badge so a mock/OCR
 *  reading is never mistaken for a real Workers AI read. */
let lastRead: ExtractionOutcome["source"] | null = null;

/** What the most recent OCR read produced — echoed into the chat so the amount
 *  choice (total vs subtotal) is visible next to the raw OCR lines. */
interface OcrRead {
  ocrText: string;
  amount: number | null;
  vendor: string | null;
  date: string | null;
  amountLine: string | null;
  /** Browser OCR settings that produced this reading (retry attempts label it). */
  config?: string;
}
let lastOcrRead: OcrRead | null = null;
/** OCR settings for the NEXT photo — the retry button cycles tesseract configs. */
let lastOcrConfig: string | null = null;

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

function readBackText(read: OcrRead): string {
  const raw = read.ocrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
  const amount = read.amount === null ? "not found" : `$${read.amount.toFixed(2)}`;
  const amountLine = read.amountLine ? ` (from line "${read.amountLine}")` : "";
  return [
    `🔎 OCR read${read.config ? ` — ${read.config}` : ""}`,
    `Amount: ${amount}${amountLine}`,
    `Date: ${read.date ?? "not found"}`,
    `Vendor: ${read.vendor ?? "not found"}`,
    "",
    "Raw lines:",
    raw,
  ].join("\n");
}

/** Real image bytes uploaded from the browser console (M8: real image path). */
const uploadedMedia = new Map<string, StoredDemoMedia>();

export function setDemoMedia(mediaId: string, media: StoredDemoMedia): void {
  uploadedMedia.set(mediaId, media);
}

export function getDemoMedia(mediaId: string): StoredDemoMedia | undefined {
  return uploadedMedia.get(mediaId);
}

class DemoMessenger implements Messenger {
  async sendText(_to: string, text: string): Promise<void> {
    messages.push({ from: "bot", text });
  }

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const stored = uploadedMedia.get(mediaId);
    if (stored) return { bytes: stored.bytes, mimeType: stored.mimeType };
    // No upload yet (plain simulated photo) — fixture bytes (no real image)
    // (if configured) so the pipeline falls back to the regex path, which is
    // exactly the machine-read confirm flow.
    return { bytes: new TextEncoder().encode("bill-snap-demo-image"), mimeType: "image/jpeg" };
  }
}

/** The demo's own deps: real D1 + R2 stores when bindings present, else in-memory. */
export function demoDeps(config: AppConfig, ai?: WorkersAi, bindings?: CloudBindings): RouteDeps {
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
        // Learn vendors from the demo phone's logged bills (the dashboard's
        // seeded bills and confirmed demo bills) so familiar merchants are
        // canonicalised on re-read — same stateless extraction underneath.
        const logged = await drafts.listLogged(DEMO_PHONE, 200);
        const learned = logged.map((d) => d.extraction?.vendor.value ?? null);
        const outcome = await inner.run({ ...input, knownVendors: mergeKnownVendors(learned) });
        lastRead = outcome.source;
        // OCR reads echo back into the chat: the raw lines next to the amount
        // the picker chose, so the total-vs-subtotal decision is visible.
        if (input.ocrText && input.ocrText.trim() !== "") {
          const read: OcrRead = {
            ocrText: input.ocrText,
            amount: outcome.extraction.amount.value,
            vendor: outcome.extraction.vendor.value,
            date: outcome.extraction.date.value,
            amountLine: amountLineOf(input.ocrText, outcome.extraction.amount.value),
            config: lastOcrConfig ?? undefined,
          };
          lastOcrRead = read;
          messages.push({ from: "bot", text: readBackText(read) });
        }
        return outcome;
      },
    },
    send: new DemoMessenger(),
    storage,
    config,
  };
}

export async function simulatePhoto(
  config: AppConfig,
  ai: WorkersAi | undefined,
  fileName?: string,
  ocrText?: string,
  ocrConfig?: string,
  bindings?: CloudBindings,
): Promise<void> {
  lastOcrConfig = ocrConfig ?? null;
  const event: InboundEvent = {
    userPhone: DEMO_PHONE,
    waMessageId: `wamid.demo.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "photo",
    imageUrls: [DEMO_MEDIA_ID],
    ocrText,
  };
  messages.push({
    from: "user",
    text: fileName ? `📷 (bill photo sent: ${fileName})` : "📷 (bill photo sent)",
  });
  await route(event, demoDeps(config, ai, bindings));
}

export async function simulateText(
  config: AppConfig,
  ai: WorkersAi | undefined,
  text: string,
  bindings?: CloudBindings,
): Promise<void> {
  const event: InboundEvent = {
    userPhone: DEMO_PHONE,
    waMessageId: `wamid.demo.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "text",
    text,
  };
  messages.push({ from: "user", text });
  await route(event, demoDeps(config, ai, bindings));
}

export interface DemoState {
  messages: DemoMessage[];
  draft: {
    id: string;
    flowState: string | null;
    status: string;
    gateLevel?: string;
    machineRead?: boolean;
    extraction?: {
      amount: number | null;
      date: string | null;
      vendor: string | null;
      abn: string | null;
      gst: number | null;
      gst_basis: string;
      invoice_number: string | null;
    };
  } | null;
  persistence: "d1" | "in-memory";
  /** Which extractor reads uploaded photos — "mock" is CANNED, never a real read. */
  extractor: string;
  /** Actual source of the most recent photo extraction (what the badge shows). */
  lastRead: ExtractionOutcome["source"] | null;
}

export async function demoState(config: AppConfig, ai?: WorkersAi, bindings?: CloudBindings): Promise<DemoState> {
  const deps = demoDeps(config, ai, bindings);
  const draft = await deps.drafts.findActiveDraft(DEMO_PHONE);
  return {
    messages,
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
                abn: draft.extraction.abn.value,
                gst: draft.extraction.gst.value,
                gst_basis: draft.extraction.gst_basis,
                invoice_number: draft.extraction.invoice_number.value,
              }
            : undefined,
        }
      : null,
    persistence: bindings?.db ? "d1" : "in-memory",
    extractor: config.geminiMock
      ? "mock (canned)"
      : ai
        ? "Workers AI + local OCR fallback"
        : "local OCR",
    lastRead,
  };
}

/** Test helper: clear the shared in-memory stack, message log, and uploaded media. */
export function resetDemo(): void {
  resetSharedMemoryStack();
  messages.length = 0;
  uploadedMedia.clear();
  lastRead = null;
  lastOcrRead = null;
  lastOcrConfig = null;
}

const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — browser demo</title>
<style>
${BASE_STYLES}
  body { height: 100dvh; display: flex; flex-direction: column; }
  #chat { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
  .msg {
    max-width: 72%; padding: 9px 13px; border-radius: var(--radius-md);
    white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.5;
    margin: 2px 0; box-shadow: var(--shadow-sm);
  }
  @media (prefers-reduced-motion: no-preference) { .msg { animation: msg-in 0.18s ease-out; } }
  .msg.user { align-self: flex-end; background: #1c3766; color: #eef3ff; }
  .msg.bot { align-self: flex-start; background: var(--surface-3); color: var(--text); }
  .msg.system { align-self: center; background: transparent; color: var(--text-faint); font-size: 12px; box-shadow: none; }
  .composer { padding: 12px 20px; background: var(--surface); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .composer-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .composer-divider { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }
  .composer-reply { display: flex; gap: 8px; }
  .composer-reply .text-input { flex: 1; min-width: 160px; }
  #hint { padding: 10px 20px 14px; }
</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconMessageCircle}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Demo console</div></div>
    </div>
    <nav class="topbar-nav"><a class="nav-link" href="/dev/dashboard">${iconBarChart} Dashboard</a></nav>
    <div class="topbar-status"><span id="badge" class="status-badge"></span></div>
  </header>
  <div id="mocknote" class="notice notice-warn">
    <span class="notice-icon">${iconAlertTriangle}</span>
    <span><strong>Mock extractor active</strong> — uploaded photos are <em>not</em> being read by the real parser. Readings are canned demo bills picked by a hash of the OCR text. Set <code>GEMINI_MOCK=false</code> and run with a Workers AI binding to use the real <code>env.AI</code> fallback.</span>
  </div>
  <div id="ocrnote" class="notice notice-success">
    <span class="notice-icon">${iconSearch}</span>
    <span><strong>Local OCR active</strong> — uploaded photos are read in your browser (tesseract.js) and the text is parsed by the regex extractor. No API needed; the Workers AI binding takes over as the fallback when regex fails.</span>
  </div>
  <div id="chat"></div>
  <div class="composer">
    <div class="composer-actions">
      <input type="file" id="file" accept="image/*" hidden />
      <button id="photo" class="btn btn-primary">${iconCamera}<span id="photo-label">Send a bill photo</span></button>
      <button id="sample" class="btn btn-ghost">${iconReceipt}<span>Sample bill</span></button>
      <button id="retry" class="btn btn-ghost" hidden>${iconRefresh}<span id="retry-label">Retry OCR</span></button>
      <span class="composer-divider" aria-hidden="true"></span>
      <button id="help" class="btn btn-icon" title="Help" aria-label="Help">${iconHelp}</button>
      <button id="undo" class="btn btn-icon" title="Delete last" aria-label="Delete last">${iconTrash}</button>
    </div>
    <div class="composer-reply">
      <input id="text" class="text-input" placeholder="Reply as text… e.g. 1, 2, 3, 4, or setup" />
      <button id="send" class="btn btn-primary btn-icon" title="Send" aria-label="Send">${iconSend}</button>
    </div>
  </div>
  <p id="hint" class="hint">Tip: <strong>Sample bill</strong> draws a bill (Subtotal / GST / split-line Total) and OCRs it, so you can see the raw lines and the captured amount/date. If a reading looks wrong, hit <strong>Retry OCR</strong> — it re-reads the same photo with different tesseract settings (sparse layout, digit whitelist) and the read-back labels which one produced the reading. Or pick your own photo — read locally by OCR, with the Workers AI fallback when regex can't find the amount. Or send text like <code>wages 500 rajesh</code>. Reply 1 to confirm, 4 to skip, or delete to undo. OCR needs internet for its engine files (jsDelivr CDN) on first use.</p>
<script>
  const chat = document.getElementById("chat");
  const badge = document.getElementById("badge");
  let rendered = 0;
  function chip(text, variant) {
    const span = document.createElement("span");
    span.className = "chip" + (variant ? " chip-" + variant : "");
    span.textContent = text;
    return span;
  }
  function render(state) {
    while (rendered < state.messages.length) {
      const m = state.messages[rendered++];
      const div = document.createElement("div");
      div.className = "msg " + m.from;
      div.textContent = m.text;
      chat.appendChild(div);
    }
    chat.scrollTop = chat.scrollHeight;
    const d = state.draft;
    badge.innerHTML = "";
    badge.appendChild(chip(state.persistence === "d1" ? "D1 + R2" : "in-memory"));
    badge.appendChild(chip(state.extractor));
    if (state.lastRead) badge.appendChild(chip("read: " + state.lastRead, "accent"));
    badge.appendChild(chip(d ? d.flowState + " (" + d.status + (d.gateLevel ? ", " + d.gateLevel : "") + ")" : "no active draft", d ? "accent" : undefined));
    document.getElementById("mocknote").style.display = state.extractor === "mock (canned)" ? "flex" : "none";
    document.getElementById("ocrnote").style.display = state.extractor === "local OCR" || state.extractor === "Workers AI + local OCR fallback" ? "flex" : "none";
  }
  async function refresh() {
    const res = await fetch("/dev/demo/state");
    render(await res.json());
  }
  async function act(url, body) {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    await refresh();
  }
  const fileInput = document.getElementById("file");
  const photoBtn = document.getElementById("photo");
  const photoLabel = document.getElementById("photo-label");
  photoBtn.onclick = () => fileInput.click();
  // Local OCR (no API): read the image text in the browser, send it with the
  // bytes. The pipeline labels it source "ocr" and regex-parses it.
  // Retry cycles tesseract configs so a bad first read can be re-attempted with
  // different segmentation (PSM) or a character whitelist — the reading that
  // wins is the one you see on the confirm screen.
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
  const retryBtn = document.getElementById("retry");
  // Preprocess a photo for OCR: upscale small images and binarize with Otsu
  // thresholding. Phone-compressed photos (e.g. a 232x299 JPEG) OCR as garbage
  // raw; upscaling + binarization turns them into clean text.
  async function preprocessForOcr(f) {
    const url = URL.createObjectURL(f);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const target = 1200;
    const scale = Math.min(4, Math.max(1, target / Math.max(w, h)));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
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
    // Bias Otsu down (~0.75x, clamped): photos on textured backgrounds skew
    // the histogram high and wash out faint digits. Verified on the HDFC
    // receipt — reads "AMOUNT Rs 321.68" only with the biased threshold;
    // 0.8x lands at 113 where the TOTAL line reads "48".
    const thr = Math.max(90, Math.min(170, Math.round(otsu * 0.75)));
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const v = gray[j] > thr ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return { blob, scale, threshold: thr };
  }
  async function sendBill(f, name) {
    lastFile = f;
    lastName = name;
    const cfg = OCR_CONFIGS[ocrIndex % OCR_CONFIGS.length];
    const orig = photoLabel.textContent;
    photoLabel.textContent = "OCR reading image…";
    photoBtn.disabled = true;
    let ocrText = "";
    let prep = null;
    try {
      if (window.Tesseract) {
        prep = await preprocessForOcr(f);
        const res = await window.Tesseract.recognize(prep.blob, "eng", cfg.opts);
        ocrText = (res && res.data && res.data.text) || "";
      }
    } catch (e) {
      // OCR unavailable — send the bytes without text (regex on nothing).
    }
    const fd = new FormData();
    fd.append("file", f);
    if (ocrText.trim()) fd.append("ocrText", ocrText);
    const prepLabel = prep ? "preprocess " + prep.scale + "x/@" + prep.threshold : null;
    const label = cfg.name !== "default" ? cfg.name : null;
    if (label || prepLabel) fd.append("ocrConfig", [label, prepLabel].filter(Boolean).join(" · "));
    await fetch("/dev/demo/photo", { method: "POST", body: fd });
    ocrIndex++;
    fileInput.value = "";
    photoLabel.textContent = orig;
    photoBtn.disabled = false;
    retryBtn.hidden = false;
    document.getElementById("retry-label").textContent = "Retry OCR (next: " + OCR_CONFIGS[ocrIndex % OCR_CONFIGS.length].name + ")";
    await refresh();
  }
  retryBtn.onclick = () => { if (lastFile) sendBill(lastFile, lastName); };
  fileInput.onchange = () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) sendBill(f, f.name);
  };
  document.getElementById("sample").onclick = () => {
    // Draw a bill with Subtotal / GST / split-line Total on a canvas, then run
    // the exact same OCR → upload flow so the amount choice is visible.
    const c = document.createElement("canvas");
    c.width = 640; c.height = 400;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("Origin Energy", 40, 64);
    ctx.font = "26px sans-serif";
    ctx.fillText("Electricity account", 40, 102);
    ctx.fillText("10/08/2026", 40, 140);
    ctx.fillText("Subtotal: $243.00", 40, 196);
    ctx.fillText("GST: $24.30", 40, 234);
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("Total:", 40, 290);
    ctx.fillText("$267.30", 40, 328);
    c.toBlob((blob) => {
      if (blob) sendBill(new File([blob], "sample-bill.png", { type: "image/png" }), "sample-bill.png");
    }, "image/png");
  };
  document.getElementById("help").onclick = () => act("/dev/demo/text", { text: "help" });
  document.getElementById("undo").onclick = () => act("/dev/demo/text", { text: "delete" });
  document.getElementById("send").onclick = () => {
    const input = document.getElementById("text");
    if (input.value.trim()) { act("/dev/demo/text", { text: input.value.trim() }); input.value = ""; }
  };
  document.getElementById("text").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("send").click(); });
  refresh();
  setInterval(refresh, 1500);
</script>
</body>
</html>`;

export function renderDemoPage(): string {
  return DEMO_PAGE;
}
