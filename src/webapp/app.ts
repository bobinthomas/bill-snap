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
  iconBackspace,
  iconBarChart,
  iconCamera,
  iconCheckCircle,
  iconChevronRight,
  iconImage,
  iconPencil,
  iconRefresh,
  iconTrash,
  iconUndo,
  iconXCircle,
} from "../dev/icons";

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

/**
 * Manual entry: skips the photo/OCR step entirely and creates a blank draft
 * that lands straight on the confirm screen with every field "Not found —
 * edit to add" — exactly the fallback the pipeline already uses when a photo
 * can't be read at all (extraction/pipeline.ts). The webapp then jumps the
 * user straight into editing the amount (the one field every bill needs).
 */
export async function webManualEntry(
  config: AppConfig,
  ai: WorkersAi | undefined,
  deviceId: string,
  bindings?: CloudBindings,
): Promise<void> {
  await webPhoto(config, ai, deviceId, null, undefined, undefined, undefined, bindings);
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

/**
 * The confirm-flow reply text ("Reply `delete` within …") assumes WhatsApp's
 * chat surface, where that's a real, literal instruction. The webapp has no
 * reply/chat affordance — deletion happens via the Delete button on the
 * Recent list, whose window is WEB_DELETE_WINDOW_MS — so rewrite it here
 * rather than in the shared screens.ts, which WhatsApp still uses as-is.
 */
function webifyReply(text: string): string {
  return text.replace(
    /Reply `delete` within .+? to undo\.$/,
    "Tap Delete on it in Recent (below) within 2 hours to undo.",
  );
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
    lastReply: list.length > 0 ? webifyReply(list[list.length - 1]!) : null,
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
 * The mobile-first webapp page. Self-contained (inline CSS/JS): an Apple
 * Wallet/Pay/Cash-inspired dark UI — a big camera/upload button, in-browser
 * OCR (tesseract.js), a grouped confirm card with a bottom-sheet amount
 * keypad, Confirm & Save / Skip / Undo, and the device's recent logged bills.
 */
const WEB_APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>BillSnap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #000000; --bg-elevated: #1c1c1e; --bg-elevated-2: #2c2c2e; --bg-elevated-3: #3a3a3c;
    --hairline: rgba(255,255,255,0.14); --hairline-soft: rgba(255,255,255,0.08);
    --label: #ffffff; --label-secondary: rgba(235,235,245,0.60); --label-tertiary: rgba(235,235,245,0.30);
    --blue: #0a84ff; --blue-soft: rgba(10,132,255,0.16); --blue-border: rgba(10,132,255,0.32);
    --green: #30d158; --green-soft: rgba(48,209,88,0.16); --green-border: rgba(48,209,88,0.32);
    --orange: #ff9f0a; --orange-soft: rgba(255,159,10,0.16); --orange-border: rgba(255,159,10,0.32);
    --red: #ff453a; --red-soft: rgba(255,69,58,0.16); --red-border: rgba(255,69,58,0.32);
    --radius-sm: 10px; --radius-md: 14px; --radius-lg: 20px; --radius-xl: 26px; --radius-pill: 999px;
    --font: 'Google Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-numeral: 'IBM Plex Mono', ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --navbar-h: 52px;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: var(--bg); }
  body {
    font-family: var(--font); color: var(--label); -webkit-font-smoothing: antialiased;
    height: 100dvh; overflow: hidden;
  }
  a { color: var(--blue); }
  a:hover { color: #409cff; }
  button { font: inherit; color: inherit; background: none; border: none; padding: 0; margin: 0; }
  .icon { width: 16px; height: 16px; flex: none; display: block; }

  .navbar {
    position: sticky; top: 0; z-index: 5; flex: none; display: flex; align-items: center;
    justify-content: space-between; height: var(--navbar-h); padding: 0 16px;
    background: rgba(28,28,30,0.72); backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%); border-bottom: 1px solid var(--hairline);
  }
  .navbar .brand { display: flex; align-items: center; gap: 8px; }
  .navbar .brand-mark {
    width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: var(--blue-soft); border: 1px solid var(--blue-border); color: var(--blue);
  }
  .navbar .brand-title { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
  .navbar .trailing { display: flex; align-items: center; gap: 8px; }
  .navbar .icon-btn {
    width: 32px; height: 32px; border-radius: var(--radius-pill); display: flex; align-items: center; justify-content: center;
    background: var(--bg-elevated); color: var(--label-secondary); border: 1px solid var(--hairline-soft);
  }
  .toggle-pill {
    display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px 0 10px;
    border-radius: var(--radius-pill); font-size: 12.5px; font-weight: 700; font-family: inherit; cursor: pointer;
    background: var(--bg-elevated); border: 1px solid var(--hairline-soft); color: var(--label-secondary);
    transition: background-color .15s ease, border-color .15s ease, color .15s ease;
  }
  .toggle-pill.on { background: var(--green-soft); border-color: var(--green-border); color: var(--green); }
  .toggle-pill .icon { width: 14px; height: 14px; }

  main {
    position: absolute; top: var(--navbar-h); left: 0; right: 0; bottom: 0; overflow-y: auto;
    padding: 8px 20px 160px; max-width: 560px; margin: 0 auto;
  }
  .section-label { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--label-secondary); margin: 20px 4px 8px; }

  #hero { text-align: center; padding: 8px 0 26px; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px 6px 10px; border-radius: var(--radius-pill);
    background: var(--blue-soft); border: 1px solid var(--blue-border); color: var(--blue);
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  }
  .eyebrow .dot { width: 5px; height: 5px; border-radius: 999px; background: var(--blue); }
  #hero h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin: 16px 0 0; }
  #hero p { font-size: 15px; line-height: 1.45; color: var(--label-secondary); margin: 6px auto 0; max-width: 29ch; }

  #preview {
    display: none; width: 100%; max-height: 220px; object-fit: contain; border-radius: var(--radius-lg);
    background: var(--bg-elevated); border: 1px solid var(--hairline-soft); margin: 0 0 16px;
  }
  #status {
    display: none; align-items: center; justify-content: center; gap: 8px; text-align: center;
    font-size: 13.5px; color: var(--label-secondary); margin: 0 0 16px;
  }
  #status .icon { width: 16px; height: 16px; }

  .notice {
    display: none; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: var(--radius-md);
    border: 1px solid; font-size: 13px; line-height: 1.5; margin: 0 0 16px;
  }
  .notice .notice-icon { flex: none; margin-top: 1px; }
  .notice .notice-icon .icon { width: 16px; height: 16px; }
  .notice-success { background: var(--green-soft); border-color: var(--green-border); color: var(--green); }
  .notice-warn { background: var(--orange-soft); border-color: var(--orange-border); color: var(--orange); }

  .processing-inline { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 0 16px; }
  .processing-inline .icon { width: 22px; height: 22px; color: var(--blue); }
  .processing-inline span { font-size: 15px; font-weight: 600; color: var(--label); }
  @media (prefers-reduced-motion: no-preference) {
    #status .icon, .processing-inline .icon { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  }

  .confidence { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; margin: 0 4px 14px; }
  .confidence .icon { width: 16px; height: 16px; }
  .confidence.ok { color: var(--green); }
  .confidence.warn { color: var(--orange); }

  .amount-card {
    position: relative; width: 100%; background: var(--bg-elevated); border: 1px solid var(--hairline-soft);
    border-radius: var(--radius-xl); padding: 26px 20px 24px; text-align: center; margin-bottom: 16px; font-family: inherit;
  }
  .amount-card.static { opacity: .78; }
  .amount-card .edit-hint {
    position: absolute; top: 16px; right: 16px; width: 28px; height: 28px; border-radius: 999px;
    background: var(--bg-elevated-2); display: flex; align-items: center; justify-content: center; color: var(--label-secondary);
  }
  .amount-card .edit-hint .icon { width: 14px; height: 14px; }
  .amount-card .label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--label-secondary); }
  .amount-card .value { font-family: var(--font-numeral); font-size: 44px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: 8px; }
  .amount-card .value.missing { font-family: var(--font); font-size: 15px; font-weight: 400; color: var(--orange); margin-top: 10px; }

  .group { background: var(--bg-elevated); border: 1px solid var(--hairline-soft); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 16px; }
  .row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 12px 16px; width: 100%; font-family: inherit; text-align: left; color: inherit; }
  .row + .row { border-top: 1px solid var(--hairline); }
  button.row { cursor: pointer; }
  .row .k { font-size: 14.5px; color: var(--label-secondary); flex: none; }
  .row .v { font-size: 15px; font-weight: 600; margin-left: auto; }
  .row .v.missing { font-weight: 400; color: var(--orange); font-size: 13.5px; }
  .row .chev { color: var(--label-secondary); flex: none; }
  .row .chev .icon { width: 14px; height: 14px; }

  .row .avatar {
    width: 36px; height: 36px; border-radius: 11px; flex: none; background: var(--bg-elevated-2);
    color: var(--label-secondary); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700;
  }
  .row .row-main { min-width: 0; flex: 1; }
  .row .row-title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .row-sub { font-size: 12.5px; color: var(--label-secondary); margin-top: 1px; }
  .row .row-trailing { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
  .row .row-amt { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .row .row-delete {
    display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600;
    color: var(--label-tertiary); font-family: inherit; cursor: pointer;
  }
  .row .row-delete .icon { width: 11px; height: 11px; }
  .row .row-delete:hover { color: var(--red); }
  .group .empty { padding: 16px; color: var(--label-secondary); font-size: 13px; }

  .dock {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; background: rgba(28,28,30,0.78);
    backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-top: 1px solid var(--hairline); padding: 14px 20px calc(14px + env(safe-area-inset-bottom));
    max-width: 560px; margin: 0 auto; justify-content: center;
  }
  #captureDock .capture-row { display: flex; align-items: flex-start; justify-content: center; gap: 34px; }
  .dock-btn { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; margin-top: 10px; }
  .dock-btn .tile { width: 52px; height: 52px; border-radius: 16px; background: var(--bg-elevated-2); border: 1px solid var(--hairline-soft); display: flex; align-items: center; justify-content: center; color: var(--label); }
  .dock-btn .tile .icon { width: 22px; height: 22px; }
  .dock-btn .lbl { font-size: 10.5px; font-weight: 600; color: var(--label-secondary); letter-spacing: 0.02em; }
  .shutter { width: 72px; height: 72px; border-radius: 999px; background: #367af1; border: 3px solid rgba(255,255,255,0.28); box-shadow: 0 0 0 2px rgba(255,255,255,0.06); cursor: pointer; }
  .shutter:disabled { opacity: .5; cursor: not-allowed; }

  #actions { display: none; }
  .btn-primary {
    display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 54px;
    border-radius: var(--radius-md); background: #ffffff; color: #000000; font-size: 16px; font-weight: 700; cursor: pointer;
  }
  .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary .icon { width: 18px; height: 18px; }
  .secondary-links { display: flex; align-items: center; justify-content: center; gap: 20px; margin-top: 12px; }
  .text-link { font-size: 13px; font-weight: 600; color: var(--label-secondary); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 8px 6px; }
  .text-link .icon { width: 14px; height: 14px; }

  #editOverlay { display: none; position: fixed; inset: 0; z-index: 20; flex-direction: column; justify-content: flex-end; }
  .edit-scrim { position: absolute; inset: 0; background: rgba(0,0,0,0.55); border: none; padding: 0; cursor: default; }
  .edit-sheet {
    position: relative; background: var(--bg-elevated); border-top-left-radius: var(--radius-xl); border-top-right-radius: var(--radius-xl);
    border: 1px solid var(--hairline-soft); border-bottom: none; box-shadow: 0 -24px 60px -20px rgba(0,0,0,0.7);
    padding-bottom: env(safe-area-inset-bottom); max-width: 560px; width: 100%; margin: 0 auto;
  }
  .edit-sheet .grabber { width: 36px; height: 5px; border-radius: 999px; background: var(--hairline); margin: 10px auto 2px; }
  .sheet-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px 2px; }
  .sheet-header .cancel { font-size: 16px; font-weight: 400; color: var(--blue); cursor: pointer; }
  .sheet-header .title { font-size: 16px; font-weight: 600; }
  .sheet-header .spacer { width: 52px; }

  .amount-entry { text-align: center; padding: 22px 20px 4px; }
  .amount-entry .display { font-family: var(--font-numeral); font-size: 46px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .amount-entry .caret { display: inline-block; width: 2px; height: 36px; margin-left: 3px; vertical-align: middle; border-radius: 2px; background: var(--blue); }
  .amount-entry .hint { font-size: 13px; color: var(--label-secondary); margin-top: 8px; }
  .keypad { display: grid; grid-template-columns: repeat(3, 1fr); padding: 6px 20px 4px; }
  .keypad button { height: 60px; font-size: 26px; font-weight: 500; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .keypad button.del { color: var(--label-secondary); }
  .keypad button.del .icon { width: 22px; height: 22px; }

  .text-entry { padding: 20px 20px 8px; }
  .text-entry .text-display {
    display: block; width: 100%; text-align: center; font-family: inherit; font-size: 22px; font-weight: 700;
    color: var(--label); background: none; border: none; outline: none; padding: 4px 0;
  }
  .text-entry .text-display::placeholder { color: var(--label-tertiary); font-weight: 400; }
  .text-entry .hint { text-align: center; font-size: 13px; color: var(--label-secondary); margin-top: 4px; }

  .sheet-save { padding: 14px 20px 20px; }
</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
  <header class="navbar">
    <div class="brand">
      <span class="brand-mark">${iconCamera}</span>
      <span class="brand-title">BillSnap</span>
    </div>
    <div class="trailing">
      <a href="/dev/dashboard?device=" class="icon-btn dash-link" aria-label="Dashboard" title="Dashboard">${iconBarChart}</a>
      <button id="autosaveToggle" class="toggle-pill" title="High-confidence AI reads auto-log with a 24h undo when on; every bill needs Confirm &amp; Save when off"></button>
    </div>
  </header>
  <main>
    <div id="hero">
      <span class="eyebrow"><span class="dot"></span>AI-Powered Capture</span>
      <h1>Snap a bill</h1>
      <p>Take a photo — I'll read the amount, date, vendor and GST, and you confirm.</p>
    </div>
    <input type="file" id="file" accept="image/*" hidden />
    <img id="preview" alt="bill preview" />
    <div id="status">${iconRefresh}<span>Reading…</span></div>
    <div id="reply" class="notice"></div>
    <div id="draft"></div>
    <div class="section-label">Recent</div>
    <div class="group" id="recent"></div>
    <div id="badge" hidden></div>
  </main>
  <div id="captureDock" class="dock">
    <div class="capture-row">
      <button class="dock-btn" id="gallery"><span class="tile">${iconImage}</span><span class="lbl">Gallery</span></button>
      <button class="shutter" id="camera" aria-label="Take photo"></button>
      <button class="dock-btn" id="manual"><span class="tile">${iconPencil}</span><span class="lbl">Manual</span></button>
    </div>
  </div>
  <div id="actions" class="dock"></div>
  <div id="editOverlay">
    <button class="edit-scrim" id="editScrim" aria-label="Close"></button>
    <div class="edit-sheet">
      <div class="grabber"></div>
      <div class="sheet-header">
        <button class="cancel" id="editcancel">Cancel</button>
        <span class="title" id="editlabel"></span>
        <span class="spacer"></span>
      </div>
      <div id="amountEntry" class="amount-entry" hidden>
        <span class="display" id="amountDisplay"></span><span class="caret"></span>
        <div class="hint">Enter the amount from the receipt</div>
        <div class="keypad" id="keypad">
          <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button>
          <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button>
          <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button>
          <button data-k=".">.</button><button data-k="0">0</button>
          <button class="del" data-k="back" aria-label="Delete">${iconBackspace}</button>
        </div>
      </div>
      <div id="textEntry" class="text-entry" hidden>
        <input id="editvalue" class="text-display" placeholder="Value…" />
        <div class="hint" id="editHint"></div>
      </div>
      <div class="sheet-save">
        <button class="btn-primary" id="editsave">Save</button>
      </div>
    </div>
  </div>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => n == null ? "Not found" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ICON_CHECK = '${iconCheckCircle}';
  const ICON_WARN = '${iconAlertTriangle}';
  const ICON_CROSS = '${iconXCircle}';
  const ICON_UNDO = '${iconUndo}';
  const ICON_CHEV = '${iconChevronRight}';
  const ICON_REFRESH = '${iconRefresh}';
  const ICON_PENCIL = '${iconPencil}';
  const ICON_TRASH = '${iconTrash}';

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
  let autoSave = true;
  // The flowState currently shown in the edit sheet ("editing_amount", …), or
  // null when closed — lets the 3s poll re-render without wiping in-progress
  // typing (the keypad string, or the text input's value).
  let editingField = null;
  let amountValue = "";
  // True from the moment "Manual entry" creates a blank draft until its
  // auto-opened amount sheet is either saved (real data now exists) or
  // cancelled (nothing was ever entered — discard the draft rather than
  // leaving its empty confirm screen on screen, see cancelEditSheet()).
  let manualEntryPending = false;

  const EDIT_META = {
    editing_amount: { label: "Amount", kind: "amount" },
    editing_vendor: { label: "Vendor", placeholder: "Vendor or business name", inputmode: "text", hint: "Vendor or business name", kind: "text" },
    editing_date: { label: "Date", placeholder: "e.g. 19/08/2026", inputmode: "text", hint: "e.g. 19/08/2026", kind: "text" },
  };

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
    toggle.innerHTML = (autoSave ? ICON_CHECK : ICON_CROSS) + "<span>Auto-save " + (autoSave ? "On" : "Off") + "</span>";
    toggle.className = "toggle-pill" + (autoSave ? " on" : "");
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
    $("hero").style.display = s.draft ? "none" : "block";
    renderDraft(s.draft);
    const recent = $("recent");
    if (!s.recent.length) {
      recent.innerHTML = '<div class="empty">Nothing logged yet.</div>';
    } else {
      recent.innerHTML = s.recent.map((b) => {
        const initial = esc((b.vendor || "?").trim().charAt(0).toUpperCase() || "?");
        return '<div class="row"><span class="avatar">' + initial + '</span>' +
          '<div class="row-main"><div class="row-title">' + esc(b.vendor || "—") + '</div><div class="row-sub">' + esc(b.category || "") + " · " + b.confirmedAt.slice(0, 10) + '</div></div>' +
          '<div class="row-trailing"><span class="row-amt">' + money(b.amount) + '</span>' +
          '<button class="row-delete" data-delete-id="' + esc(b.id) + '" onclick="deleteBill(this.dataset.deleteId)">' + ICON_TRASH + '<span>Delete · <span class="delete-countdown" data-until="' + esc(b.deleteUntil) + '">2 hrs</span></span></button></div></div>';
      }).join("");
      updateDeleteCountdowns();
    }
  }

  function deleteBill(id) { act("delete:" + id); }

  function updateDeleteCountdowns() {
    document.querySelectorAll(".delete-countdown").forEach((el) => {
      const remaining = new Date(el.dataset.until).getTime() - Date.now();
      if (remaining <= 0) {
        el.closest(".row-delete").remove();
        return;
      }
      const minutes = Math.ceil(remaining / 60000);
      el.textContent = minutes >= 60 ? Math.ceil(minutes / 60) + " hrs" : minutes + " min";
    });
  }

  function renderDraft(d) {
    const wrap = $("draft");
    const actions = $("actions");
    const captureDock = $("captureDock");
    if (!d) {
      wrap.innerHTML = "";
      actions.style.display = "none";
      captureDock.style.display = "flex";
      closeEditSheet();
      return;
    }
    // Only one docked bar shows at a time: the shutter while idle (above),
    // the confirm actions once a draft is up for review (below) — never both.
    captureDock.style.display = "none";
    if (d.flowState && d.flowState.startsWith("editing_")) {
      wrap.innerHTML = "";
      actions.style.display = "none";
      openEditSheet(d.flowState);
      return;
    }
    closeEditSheet();
    if (!d.extraction) {
      // Draft exists (flowState "processing") but extraction hasn't landed yet —
      // a real window the 3s poll can catch while the AI call is in flight.
      wrap.innerHTML = '<div class="processing-inline">' + ICON_REFRESH + "<span>Reading your bill…</span></div>";
      actions.style.display = "none";
      return;
    }
    const e = d.extraction;
    const flagOk = !d.machineRead && d.gateLevel === "high";
    const flagIcon = flagOk ? ICON_CHECK : ICON_WARN;
    const flagText = d.machineRead ? "Machine-read, please verify" : flagOk ? "High confidence" : "Check details";
    const missing = '<span class="v missing">Not found — edit to add</span>';
    // Whole-row tap targets (56px+, no precision-aimed pencil icon) — tapping
    // anywhere on an editable row opens that field.
    const tapRow = (k, v, action) =>
      '<button class="row" onclick="' + action + '"><span class="k">' + k +
      '</span><span class="v">' + v + '</span><span class="chev">' + ICON_CHEV + "</span></button>";
    const staticRow = (k, v) => '<div class="row"><span class="k">' + k + '</span>' + v + "</div>";
    const amountCard = e.amount === null
      ? '<div class="amount-card static"><div class="label">Amount</div><div class="value missing">Not found — edit to add</div></div>'
      : '<button class="amount-card" onclick="act(\\'2\\')"><span class="edit-hint">' + ICON_PENCIL + '</span><div class="label">Amount</div><div class="value">' + money(e.amount) + "</div></button>";
    wrap.innerHTML = '<div class="confidence ' + (flagOk ? "ok" : "warn") + '">' + flagIcon + "<span>" + esc(flagText) + "</span></div>" +
      amountCard +
      '<div class="section-label" style="margin-top:0">Details</div>' +
      '<div class="group">' +
      tapRow("Vendor", e.vendor === null ? missing : '<span class="v">' + esc(e.vendor) + "</span>", "act('3')") +
      tapRow("Date", e.date === null ? missing : '<span class="v">' + esc(e.date) + "</span>", "act('5')") +
      "</div>" +
      '<div class="group">' +
      staticRow("ABN", e.abn === null ? '<span class="v missing">Not verified</span>' : '<span class="v">' + esc(e.abn) + "</span>") +
      staticRow("GST", e.gst === null ? '<span class="v">—</span>' : '<span class="v">' + money(e.gst) + "</span>") +
      "</div>";
    actions.style.display = "block";
    actions.innerHTML =
      '<button class="btn-primary" onclick="act(\\'1\\')">' + ICON_CHECK + "<span>Confirm &amp; Save</span></button>" +
      '<div class="secondary-links">' +
      '<button class="text-link" onclick="act(\\'4\\')">' + ICON_CROSS + "<span>Skip / wrong bill</span></button>" +
      '<button class="text-link" onclick="act(\\'delete\\')">' + ICON_UNDO + "<span>Undo last</span></button>" +
      "</div>";
  }

  function openEditSheet(flowState) {
    const meta = EDIT_META[flowState] || { label: "Value", placeholder: "Value…", inputmode: "text", hint: "", kind: "text" };
    $("editlabel").textContent = meta.label;
    const isNewField = editingField !== flowState;
    editingField = flowState;
    $("editOverlay").style.display = "flex";
    if (meta.kind === "amount") {
      $("amountEntry").hidden = false;
      $("textEntry").hidden = true;
      if (isNewField) amountValue = "";
      renderAmountDisplay();
    } else {
      $("amountEntry").hidden = true;
      $("textEntry").hidden = false;
      $("editvalue").placeholder = meta.placeholder;
      $("editvalue").setAttribute("inputmode", meta.inputmode);
      $("editHint").textContent = meta.hint;
      if (isNewField) $("editvalue").value = "";
      $("editvalue").focus();
    }
  }

  function closeEditSheet() {
    editingField = null;
    $("editOverlay").style.display = "none";
  }

  function renderAmountDisplay() {
    $("amountDisplay").textContent = amountValue ? "$" + amountValue : "$0";
    $("editsave").disabled = amountValue.trim() === "";
  }

  $("keypad").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-k]");
    if (!btn) return;
    const k = btn.dataset.k;
    if (k === "back") {
      amountValue = amountValue.slice(0, -1);
    } else if (k === ".") {
      if (!amountValue.includes(".")) amountValue += ".";
    } else {
      // Cap at two digits after the decimal point.
      const dot = amountValue.indexOf(".");
      if (dot === -1 || amountValue.length - dot <= 2) amountValue += k;
    }
    renderAmountDisplay();
  });

  // "4" is the shared edit sub-flow's documented cancel value (screens.ts) --
  // sending it (not just hiding the sheet locally) is what actually clears
  // the draft's editing_* flowState, so the next poll doesn't reopen it.
  // cancelEdit() on the server only backs the draft out to "awaiting_confirm"
  // (right, for a real photo capture — the confirm screen still has the
  // extracted data worth reviewing). A manual-entry draft has no extracted
  // data at all, so backing out just exposes its blank confirm screen; send
  // "4" a second time to expire that still-empty draft outright.
  const cancelEditSheet = () => {
    closeEditSheet();
    if (manualEntryPending) {
      manualEntryPending = false;
      act("4").then(() => act("4"));
    } else {
      act("4");
    }
  };
  $("editScrim").onclick = cancelEditSheet;
  $("editcancel").onclick = cancelEditSheet;
  $("editsave").onclick = () => {
    if (editingField && EDIT_META[editingField] && EDIT_META[editingField].kind === "amount") {
      const v = amountValue.trim();
      if (v) { manualEntryPending = false; act(v); amountValue = ""; }
    } else {
      const v = $("editvalue").value.trim();
      if (v) { manualEntryPending = false; act(v); $("editvalue").value = ""; }
    }
  };
  $("editvalue").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("editsave").click(); });

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
    // Scale to ~1200px on the long side: upscale small phone-compressed shots
    // (cap 4x), but — just as importantly — DOWNSCALE full-res camera photos
    // (commonly 3000-4000px). Un-downscaled, a 12MP photo runs Otsu over ~12M
    // pixels and Tesseract over the full image, which is the actual cause of
    // slow reads on real camera photos; the old floor of 1 on the scale
    // factor blocked downscaling entirely and only ever let this scale up.
    const target = 1200;
    const scale = Math.min(4, target / Math.max(w, h));
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
  // Manual entry: create a blank draft (no photo) and jump straight into
  // editing the amount — the one field every bill needs.
  $("manual").onclick = async () => {
    manualEntryPending = true;
    await fetch("/app/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device }),
    });
    await act("2");
  };
  refresh();
  setInterval(refresh, 3000);
  setInterval(updateDeleteCountdowns, 60000);
</script>
</body>
</html>`;

export function renderWebAppPage(): string {
  return WEB_APP_PAGE;
}
