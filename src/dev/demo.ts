/**
 * /dev/demo — a browser console that drives the REAL routing pipeline with
 * simulated WhatsApp messages (DEV-only, gated by config.devDemo; never in
 * production). No Meta, no phone: the demo messenger records what the bot
 * would have sent and serves fixture image bytes for the media download.
 *
 * Persistence: the real Supabase stores when configured, otherwise an
 * in-memory singleton (module scope keeps multi-turn state alive across HTTP
 * requests inside the dev isolate).
 */
import type { AppConfig } from "../config";
import { createSupabaseBusinessStore, type BusinessStore } from "../db/businesses";
import { createSupabaseDraftStore, type DraftStore } from "../db/drafts";
import { createSupabaseUserStore, type UserStore } from "../db/users";
import { createExtractionService, type ExtractionOutcome, type ExtractionService } from "../extraction/pipeline";
import type { WorkersAi } from "../extraction/workers-ai";
import type { DownloadedMedia, Messenger } from "../messaging/whatsapp";
import { createSupabaseBillStorage, type BillStorage } from "../storage/bills";
import type { InboundEvent } from "../types";
import { route, type RouteDeps } from "../webhook/router";
import { createMemoryStack, type MemoryStack } from "./memory";

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

let memory: MemoryStack | null = null;
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

function stack(): MemoryStack {
  memory ??= createMemoryStack();
  return memory;
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

/** The demo's own deps: real Supabase stores when configured, else in-memory. */
export function demoDeps(config: AppConfig, ai?: WorkersAi): RouteDeps {
  const users: UserStore = createSupabaseUserStore(config) ?? stack().users;
  const businesses: BusinessStore = createSupabaseBusinessStore(config) ?? stack().businesses;
  const drafts: DraftStore = createSupabaseDraftStore(config) ?? stack().drafts;
  const storage: BillStorage = createSupabaseBillStorage(config) ?? stack().storage;
  const inner = createExtractionService(config, ai);
  return {
    users,
    businesses,
    drafts,
    extraction: {
      async run(input) {
        const outcome = await inner.run(input);
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
  await route(event, demoDeps(config, ai));
}

export async function simulateText(config: AppConfig, ai: WorkersAi | undefined, text: string): Promise<void> {
  const event: InboundEvent = {
    userPhone: DEMO_PHONE,
    waMessageId: `wamid.demo.${Date.now()}`,
    waReceivedAt: new Date(),
    kind: "text",
    text,
  };
  messages.push({ from: "user", text });
  await route(event, demoDeps(config, ai));
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
  persistence: "supabase" | "in-memory";
  /** Which extractor reads uploaded photos — "mock" is CANNED, never a real read. */
  extractor: string;
  /** Actual source of the most recent photo extraction (what the badge shows). */
  lastRead: ExtractionOutcome["source"] | null;
}

export async function demoState(config: AppConfig, ai?: WorkersAi): Promise<DemoState> {
  const deps = demoDeps(config, ai);
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
    persistence: config.supabase.url && config.supabase.serviceRoleKey ? "supabase" : "in-memory",
    extractor: config.geminiMock
      ? "mock (canned)"
      : ai
        ? "Workers AI + local OCR fallback"
        : "local OCR",
    lastRead,
  };
}

/** Test helper: clear the in-memory stack, message log, and uploaded media. */
export function resetDemo(): void {
  memory = null;
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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b141a; color: #e9edef; font-family: -apple-system, Segoe UI, Roboto, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 20px; background: #1f2c34; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header a { color: #00a884; font-size: 13px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  #badge { font-size: 12px; color: #8696a0; }
  #mocknote, #ocrnote { display: none; margin: 8px 20px 0; padding: 8px 12px; border: 1px solid #a3712a; background: #33240f; color: #f0c36d; border-radius: 8px; font-size: 12px; }
  #ocrnote { border-color: #2a9d5f; background: #0f2e1e; color: #7ee2a8; }
  #chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 4px; }
  .msg { max-width: 70%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: 14px; margin: 2px 0; }
  .msg.user { align-self: flex-end; background: #005c4b; }
  .msg.bot { align-self: flex-start; background: #1f2c34; }
  .msg.system { align-self: center; background: transparent; color: #8696a0; font-size: 12px; }
  #controls { padding: 12px 20px; background: #1f2c34; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button { background: #00a884; color: #0b141a; border: none; border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button.ghost { background: #2a3942; color: #e9edef; }
  input { flex: 1; min-width: 160px; background: #2a3942; color: #e9edef; border: none; border-radius: 8px; padding: 8px 12px; font-size: 14px; }
  input:focus { outline: 1px solid #00a884; }
  #hint { font-size: 12px; color: #8696a0; }
</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
  <header><h1>BillSnap — browser demo</h1><a href="/dev/dashboard">📊 Dashboard</a><span id="badge"></span></header>
  <div id="mocknote">⚠️ <strong>Mock extractor active</strong> — uploaded photos are <em>not</em> being read by the real parser. Readings are canned demo bills picked by a hash of the OCR text. Set <code>GEMINI_MOCK=false</code> and run with a Workers AI binding to use the real <code>env.AI</code> fallback.</div>
  <div id="ocrnote">🔍 <strong>Local OCR active</strong> — uploaded photos are read in your browser (tesseract.js) and the text is parsed by the regex extractor. No API needed; the Workers AI binding takes over as the fallback when regex fails.</div>
  <div id="chat"></div>
  <div id="controls">
    <input type="file" id="file" accept="image/*" hidden />
    <button id="photo">📸 Send a bill photo</button>
    <button id="sample" class="ghost">🧾 Sample bill</button>
    <button id="retry" class="ghost" hidden>🔁 Retry OCR</button>
    <button id="help" class="ghost">help</button>
    <button id="undo" class="ghost">delete</button>
    <input id="text" placeholder="Reply as text… e.g. 1, 2, 3, 4, or setup" />
    <button id="send">Send</button>
  </div>
  <div id="hint" style="padding: 0 20px 10px;">Tip: <strong>🧾 Sample bill</strong> draws a bill (Subtotal / GST / split-line Total) and OCRs it, so you can see the raw lines and the captured amount/date. If a reading looks wrong, hit <strong>🔁 Retry OCR</strong> — it re-reads the same photo with different tesseract settings (sparse layout, digit whitelist) and the read-back labels which one produced the reading. Or pick your own photo — read locally by OCR, with the Workers AI fallback when regex can't find the amount. Or send text like <code>wages 500 rajesh</code>. Reply 1 to confirm, 4 to skip, or delete to undo. OCR needs internet for its engine files (jsDelivr CDN) on first use.</div>
<script>
  const chat = document.getElementById("chat");
  const badge = document.getElementById("badge");
  let rendered = 0;
  function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
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
    badge.textContent = (state.persistence === "supabase" ? "persistence: Supabase" : "persistence: in-memory") +
      " · extractor: " + state.extractor +
      (state.lastRead ? " · last read: " + state.lastRead : "") +
      (d ? " · draft: " + d.flowState + " (" + d.status + (d.gateLevel ? ", " + d.gateLevel : "") + ")" : " · no active draft");
    document.getElementById("mocknote").style.display = state.extractor === "mock (canned)" ? "block" : "none";
    document.getElementById("ocrnote").style.display = state.extractor === "local OCR" || state.extractor === "Workers AI + local OCR fallback" ? "block" : "none";
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
  async function sendBill(f, name) {
    lastFile = f;
    lastName = name;
    const cfg = OCR_CONFIGS[ocrIndex % OCR_CONFIGS.length];
    const orig = photoBtn.textContent;
    photoBtn.textContent = "🔍 OCR reading image…";
    photoBtn.disabled = true;
    let ocrText = "";
    try {
      if (window.Tesseract) {
        const res = await window.Tesseract.recognize(f, "eng", cfg.opts);
        ocrText = (res && res.data && res.data.text) || "";
      }
    } catch (e) {
      // OCR unavailable — send the bytes without text (regex on nothing).
    }
    const fd = new FormData();
    fd.append("file", f);
    if (ocrText.trim()) fd.append("ocrText", ocrText);
    if (cfg.name !== "default") fd.append("ocrConfig", cfg.name);
    await fetch("/dev/demo/photo", { method: "POST", body: fd });
    ocrIndex++;
    fileInput.value = "";
    photoBtn.textContent = orig;
    photoBtn.disabled = false;
    retryBtn.hidden = false;
    retryBtn.textContent = "🔁 Retry OCR (next: " + OCR_CONFIGS[ocrIndex % OCR_CONFIGS.length].name + ")";
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
