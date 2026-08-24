/**
 * Screen renderers (§4.5, §6.1, §6.2, §6.3).
 */
import type { AppConfig } from "../config";
import type { DraftRecord } from "../db/drafts";

export const WELCOME_TEXT = `👋 Welcome to BillSnap!

Snap a photo of any bill or invoice — I'll read the amount,
date, vendor, and GST, and you just tap confirm.

No photo? Log cash payments as text: wages 500 rajesh

Reply \`setup\` to set your business name, timezone, and GST
status — or send your first bill now.`;

export const HELP_TEXT = `📚 BillSnap commands

📸 Send a photo of a bill or invoice — I'll read it and log it.
💬 Log without a photo: \`wages 500 rajesh\` — add a date like \`10-Aug-2026\`\n📊 \`summary\` / \`today\` — daily totals
🔍 \`find <keyword>\` — search past bills
↩️ \`delete\` — undo the last transaction
⚙️ \`setup\` — business name, timezone, GST
🔐 \`autosave on\` / \`autosave off\` — auto-log high-confidence AI reads, or always confirm first
▶️ \`NEXT\` — process next queued image
❓ \`help\` — this list`;

export const UNKNOWN_COMMAND_TEXT = `❓ Didn't catch that. Reply \`help\` to see what I can do.`;

export const AUTOSAVE_OFF_TEXT =
  "🔒 Auto-log turned off. Every bill — including high-confidence AI reads — now waits for your Confirm & Save.";
export const AUTOSAVE_ON_TEXT =
  "⚡ Auto-log turned on. High-confidence AI reads log immediately with a 24-hour undo window (reply `delete` to undo).";

export const EDIT_AMOUNT_PROMPT = "✏️ Edit amount — reply with the correct amount, e.g. `245.00` (or `4` to cancel).";
export const EDIT_AMOUNT_RETRY = "That doesn't look like an amount — reply with digits only, e.g. `245.00`.";
export const EDIT_VENDOR_PROMPT = "✏️ Edit vendor — reply with the correct business name, e.g. `Telstra` (or `4` to cancel).";
export const EDIT_VENDOR_RETRY = "Reply with the correct business name, e.g. `Telstra`.";
export const EDIT_DATE_PROMPT = "✏️ Edit date — reply with the correct date, e.g. `10/08/2026` (or `4` to cancel).";
export const EDIT_DATE_RETRY = "Reply a date like `10/08/2026` or `10-Aug-2026`.";
export const EDIT_CATEGORY_PROMPT =
  "✏️ Edit category — reply with the correct category, e.g. `rent`, `utilities`, `wages`, `inventory`, or `misc` (or `4` to cancel).";
export const EDIT_CATEGORY_RETRY = "Reply with a category, e.g. `rent`, `utilities`, `wages`, `inventory`, or `misc`.";
export const EDIT_CANCELLED_TEXT = "↩️ Edit cancelled.";

export const NUDGE_TEXT = "⏳ This bill isn't saved yet. Reply `1` to confirm, `2`/`3` to edit, or `4` to skip.";
export const SKIPPED_TEXT = "❌ Skipped. Nothing was saved.";
export const UNDO_NOTHING_TEXT = "Nothing to undo.";
export const UNDO_WINDOW_TEXT = "That transaction is outside the undo window.";
export const UNDONE_TEXT = "↩️ Undone — transaction deleted.";

export const SETUP_NAME_PROMPT = "🏢 Setup — Business name? (currently: My Business)";
export const SETUP_NAME_RETRY = "Reply with a business name, or `skip` to keep the current one.";
export const SETUP_TIMEZONE_PROMPT =
  "⏰ Timezone? Reply `sydney`, `melbourne`, `brisbane`, `perth`, `adelaide`, `darwin`, `hobart`, or `canberra` (currently Australia/Sydney)";
export const SETUP_TIMEZONE_RETRY =
  "Reply one of: sydney, melbourne, brisbane, perth, adelaide, darwin, hobart, canberra — or `skip`.";
export const SETUP_GST_PROMPT = "🧾 Are you GST-registered? Reply `yes` or `no` (currently yes)";
export const SETUP_GST_RETRY = "Reply `yes` or `no` — or `skip` to keep the current setting.";
export const SETUP_DONE_TEXT = "✅ Settings saved. Send your first bill!";
export const SETUP_CANCELLED_TEXT = "Setup cancelled.";

/** §6.2 confirm screen, adapted to the gating level and machine-read flag. */
export function renderConfirmScreen(draft: DraftRecord, config: AppConfig): string {
  const e = draft.extraction;
  const t = config.extraction;
  const missing = "Not found — edit to add";

  const header = draft.machineRead
    ? "📄 Bill Read — ⚠️ Machine-read, please verify"
    : draft.gateLevel === "high"
      ? "📄 Bill Read — ✅ High confidence"
      : "📄 Bill Read — ⚠️ Check details";

  const amount = e?.amount.value ?? null;
  const amountFlag = amount !== null && e !== undefined && e.amount.confidence < t.amountHigh ? " ⚠️ verify" : "";
  const vendor = e?.vendor.value ?? null;
  const vendorFlag = vendor !== null && e !== undefined && e.vendor.confidence < t.vendorHigh ? " ⚠️ verify" : "";
  const date = e?.date.value ?? null;
  const dateLow = date !== null && e !== undefined && e.date.confidence < t.dateHigh;
  const dateFlag = dateLow ? " ⚠️ verify" : "";
  const abn = e?.abn.value ?? null;
  const gst = e?.gst.value ?? null;
  const category = e?.category_hint.value ?? null;

  const lines = [
    header,
    "",
    `Amount: ${amount === null ? missing : formatAUD(amount) + amountFlag}`,
    `Vendor: ${vendor === null ? missing : vendor + vendorFlag}`,
    `Date: ${date === null ? missing : date + dateFlag}`,
    `Category: ${category === null ? missing : category}`,
    `ABN: ${abn === null ? "Not verified" : abn}`,
    `GST: ${gst === null ? "—" : formatAUD(gst)}`,
    "",
    "Reply:",
    "1️⃣ Confirm & Save",
    "2️⃣ Edit amount",
    "3️⃣ Edit vendor",
    "6️⃣ Edit category",
  ];
  if (date === null || dateLow) lines.push("5️⃣ Edit date");
  lines.push("4️⃣ Skip / Wrong bill");
  return lines.join("\n");
}

/** "✅ Logged: …" confirmation reply (§4.1 step 9). Window: 5 minutes for confirm-path, 24 hours for auto-logged (§5.8). */
export function renderLoggedReply(draft: DraftRecord, undoWindow: "24 hours" | "5 minutes" = "5 minutes"): string {
  const e = draft.extraction;
  const amount = e?.amount.value ?? 0;
  const category = e?.category_hint?.value ?? "misc";
  const vendor = e?.vendor.value ?? "—";
  const gst = e?.gst.value;
  const gstPart = gst === null || gst === undefined ? "GST: —" : `GST: ${formatAUD(gst)}`;
  return `✅ Logged: ${formatAUD(amount)} | ${category} | ${vendor}. ${gstPart}. Reply \`delete\` within ${undoWindow} to undo.`;
}

export function formatAUD(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const sign = n < 0 ? "-" : "";
  return `${sign}$${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}
