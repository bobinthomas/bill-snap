/**
 * Draft-reply dispatch (§5.6/§6.2): what happens when a user with an active
 * draft sends a reply.
 *
 * - 1 → confirm & save (status → logged)
 * - 2/3/5 → edit sub-flows (§6.3)
 * - 4 → skip / wrong bill (draft → expired)
 * - `help` → help text (draft stays active)
 *
 * TODO(M7): auto-log High + !machineRead extractions (§5.8) before the confirm
 * screen is even shown; duplicate-warning confirm/skip path.
 */
import type { DraftRecord } from "../db/drafts";
import {
  HELP_TEXT,
  SETUP_NAME_PROMPT,
  SKIPPED_TEXT,
  renderConfirmScreen,
  renderLoggedReply,
} from "../messaging/screens";
import type { InboundEvent } from "../types";
import type { RouteDeps } from "../webhook/router";
import { applyEdit, beginEdit, cancelEdit } from "./edit";

export async function handleDraftReply(
  event: InboundEvent,
  draft: DraftRecord,
  deps: RouteDeps,
): Promise<void> {
  const text = (event.text ?? "").trim().toLowerCase();

  // Editing sub-flows: the next message is the corrected value, except `4`
  // which every edit prompt documents as "cancel" — checked first so it
  // can't be swallowed as a literal amount/vendor/date value below.
  if (draft.flowState === "editing_amount" || draft.flowState === "editing_vendor" || draft.flowState === "editing_date") {
    if (text === "4") {
      await cancelEdit(draft, deps);
      return;
    }
    await applyEdit(event, draft, deps);
    return;
  }

  switch (text) {
    case "1":
      await confirmDraft(draft, deps);
      return;
    case "2":
      await beginEdit("amount", draft, deps);
      return;
    case "3":
      await beginEdit("vendor", draft, deps);
      return;
    case "4":
      await deps.drafts.expire(draft.id);
      await deps.send.sendText(draft.userPhone, SKIPPED_TEXT);
      return;
    case "5": {
      // Only offered when the date is missing or low (renderer shows it then).
      await beginEdit("date", draft, deps);
      return;
    }
    case "help":
      await deps.send.sendText(draft.userPhone, HELP_TEXT);
      return;
    case "setup":
      // Settings detour mid-confirm: start the §4.5 wizard. The router prefers
      // an ACTIVE wizard over the pending draft, so the wizard's replies aren't
      // swallowed by this branch — the draft stays and resumes when setup ends.
      await deps.businesses.setSetupStep(draft.userPhone, "name");
      await deps.send.sendText(draft.userPhone, SETUP_NAME_PROMPT);
      return;
    default:
      await deps.send.sendText(
        draft.userPhone,
        "Reply `1` to confirm, `2`/`3` to edit, `5` to edit the date, `4` to skip, or `help`/`setup`.",
      );
  }
}

export async function confirmDraft(draft: DraftRecord, deps: RouteDeps): Promise<void> {
  await deps.drafts.confirm(draft.id, new Date());
  await deps.send.sendText(draft.userPhone, renderLoggedReply(draft));
}

/** Re-send the current confirm screen (used after state changes). */
export async function resendConfirmScreen(draft: DraftRecord, deps: RouteDeps): Promise<void> {
  await deps.send.sendText(draft.userPhone, renderConfirmScreen(draft, deps.config));
}
