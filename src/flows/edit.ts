/**
 * Edit sub-flows (§6.3). Options 2/3/5 put the draft into an `editing_*` state;
 * the user's next message is validated, applied, and the confirm screen
 * re-renders. User-edited fields are treated as verified (confidence 1).
 */
import type { DraftRecord } from "../db/drafts";
import { classify } from "../extraction/gate";
import { computeGst, normaliseDate, parseAmount } from "../extraction/validate";
import {
  EDIT_AMOUNT_PROMPT,
  EDIT_AMOUNT_RETRY,
  EDIT_CANCELLED_TEXT,
  EDIT_DATE_PROMPT,
  EDIT_DATE_RETRY,
  EDIT_VENDOR_PROMPT,
  EDIT_VENDOR_RETRY,
  renderConfirmScreen,
} from "../messaging/screens";
import type { InboundEvent } from "../types";
import type { BillExtraction } from "../types";
import type { RouteDeps } from "../webhook/router";
import { resolveBusiness } from "./helpers";

export type EditKind = "amount" | "vendor" | "date";

export async function beginEdit(kind: EditKind, draft: DraftRecord, deps: RouteDeps): Promise<void> {
  const prompt =
    kind === "amount" ? EDIT_AMOUNT_PROMPT : kind === "vendor" ? EDIT_VENDOR_PROMPT : EDIT_DATE_PROMPT;
  const flowState = `editing_${kind}` as const;
  await deps.drafts.setFlowState(draft.id, { flowState });
  await deps.send.sendText(draft.userPhone, prompt);
}

/**
 * Backs out of an editing sub-flow without applying a value (the edit
 * prompts all promise "or `4` to cancel") — leaves whatever extraction
 * already existed untouched and returns to the confirm screen.
 */
export async function cancelEdit(draft: DraftRecord, deps: RouteDeps): Promise<void> {
  const updated = await deps.drafts.setFlowState(draft.id, { flowState: "awaiting_confirm" });
  await deps.send.sendText(draft.userPhone, `${EDIT_CANCELLED_TEXT}\n\n${renderConfirmScreen(updated, deps.config)}`);
}

/** Applies the user's reply for the current `editing_*` state (§6.3 step 3). */
export async function applyEdit(
  event: InboundEvent,
  draft: DraftRecord,
  deps: RouteDeps,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const base = draft.extraction ?? emptyExtraction();

  if (draft.flowState === "editing_amount") {
    const amount = parseAmount(text);
    if (amount === null) {
      await deps.send.sendText(draft.userPhone, EDIT_AMOUNT_RETRY);
      return;
    }
    const business = await resolveBusiness(deps, draft.userPhone);
    const extraction: BillExtraction = {
      ...base,
      amount: { value: amount, confidence: 1 },
      gst: {
        value: computeGst(amount, base.gst_basis, business?.gstRegistered ?? true),
        confidence: 1,
      },
    };
    await finishEdit(draft, extraction, `✅ Amount updated — $${amount.toFixed(2)}`, deps);
    return;
  }

  if (draft.flowState === "editing_vendor") {
    if (text === "" || text.length > 60) {
      await deps.send.sendText(draft.userPhone, EDIT_VENDOR_RETRY);
      return;
    }
    // A user-typed vendor is verified verbatim — clear any canonicalisation log.
    const extraction: BillExtraction = {
      ...base,
      vendor: { value: text, confidence: 1 },
      vendor_resolved_to: { value: null, confidence: 0 },
    };
    await finishEdit(draft, extraction, `✅ Vendor updated — ${text}`, deps);
    return;
  }

  if (draft.flowState === "editing_date") {
    const iso = normaliseDate(text);
    if (iso === null) {
      await deps.send.sendText(draft.userPhone, EDIT_DATE_RETRY);
      return;
    }
    const extraction: BillExtraction = { ...base, date: { value: iso, confidence: 1 } };
    await finishEdit(draft, extraction, `✅ Date updated — ${iso}`, deps);
    return;
  }

  // Not in an editing state — nothing to apply.
  await deps.send.sendText(draft.userPhone, "Nothing to edit right now.");
}

async function finishEdit(
  draft: DraftRecord,
  extraction: BillExtraction,
  confirmLine: string,
  deps: RouteDeps,
): Promise<void> {
  const gateLevel = classify(extraction, deps.config.extraction);
  const updated = await deps.drafts.setFlowState(draft.id, {
    flowState: "awaiting_confirm",
    extraction,
    gateLevel,
  });
  await deps.send.sendText(draft.userPhone, `${confirmLine}\n\n${renderConfirmScreen(updated, deps.config)}`);
}

function emptyExtraction(): BillExtraction {
  return {
    amount: { value: null, confidence: 0 },
    date: { value: null, confidence: 0 },
    vendor: { value: null, confidence: 0 },
    vendor_resolved_to: { value: null, confidence: 0 },
    abn: { value: null, confidence: 0 },
    gst: { value: null, confidence: 0 },
    gst_basis: "none",
    invoice_number: { value: null, confidence: 0 },
    due_date: { value: null, confidence: 0 },
    category_hint: { value: null, confidence: 0 },
  };
}
