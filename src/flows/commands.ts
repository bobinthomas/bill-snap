/**
 * Command parser for known users (§5.6/§6.1).
 *
 * - `help` → command list
 * - `delete` → undo the last transaction within its window (§5.6/§5.8)
 * - `setup` → start the §4.5 settings wizard
 *
 * TODO: summary/find/NEXT and the manual-entry format (`wages 500 rajesh`).
 */
import type { AppConfig } from "../config";
import type { BusinessStore } from "../db/businesses";
import type { DraftStore } from "../db/drafts";
import {
  HELP_TEXT,
  SETUP_NAME_PROMPT,
  UNDONE_TEXT,
  UNDO_NOTHING_TEXT,
  UNDO_WINDOW_TEXT,
  UNKNOWN_COMMAND_TEXT,
} from "../messaging/screens";
import type { InboundEvent } from "../types";

export interface CommandDeps {
  drafts: DraftStore;
  businesses: BusinessStore;
  config: AppConfig;
}

export async function handleCommand(
  event: InboundEvent,
  deps: CommandDeps,
): Promise<string | null> {
  const text = (event.text ?? "").trim().toLowerCase();

  if (text === "help") return HELP_TEXT;
  if (text === "delete") return undoReply(event, deps);
  if (text === "setup") {
    await deps.businesses.setSetupStep(event.userPhone, "name");
    return SETUP_NAME_PROMPT;
  }

  return UNKNOWN_COMMAND_TEXT;
}

async function undoReply(event: InboundEvent, deps: CommandDeps): Promise<string> {
  const now = new Date();
  const within24h = new Date(now.getTime() - deps.config.ttl.undoAutoLogHours * 3_600_000);
  const target = await deps.drafts.findRecentLogged(event.userPhone, within24h);

  if (!target?.confirmedAt) return UNDO_NOTHING_TEXT;

  const windowMs = target.autoLogged
    ? deps.config.ttl.undoAutoLogHours * 3_600_000
    : deps.config.ttl.undoConfirmMinutes * 60_000;
  if (target.confirmedAt.getTime() < now.getTime() - windowMs) return UNDO_WINDOW_TEXT;

  await deps.drafts.softDeleteLogged(target.id);
  return UNDONE_TEXT;
}
