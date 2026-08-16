/**
 * Message routing (§5.6). A verified InboundEvent is resolved:
 * unknown user → onboarding (§4.5; photo-first messages then proceed into the
 * photo flow); photo → draft creation; text with an active draft → draft reply
 * (§6.2); text with an active setup wizard → wizard reply (§4.5); otherwise →
 * command parser.
 */
import type { AppConfig } from "../config";
import type { BusinessStore } from "../db/businesses";
import type { DraftStore } from "../db/drafts";
import type { UserStore } from "../db/users";
import type { ExtractionService } from "../extraction/pipeline";
import { handleCommand } from "../flows/commands";
import { handleDraftReply } from "../flows/confirm";
import { handleOnboarding, handleSetupReply } from "../flows/onboarding";
import { handlePhoto } from "../flows/photo";
import type { Messenger } from "../messaging/whatsapp";
import type { BillStorage } from "../storage/bills";
import type { InboundEvent } from "../types";

export interface RouteDeps {
  users: UserStore;
  businesses: BusinessStore;
  drafts: DraftStore;
  extraction: ExtractionService;
  send: Messenger;
  storage: BillStorage;
  config: AppConfig;
}

export async function route(event: InboundEvent, deps: RouteDeps): Promise<void> {
  let user = await deps.users.findUser(event.userPhone);

  if (!user) {
    await handleOnboarding(event, deps);
    user = await deps.users.findUser(event.userPhone);
    // Text first-contact: the welcome is the whole reply (§4.5). Photo first
    // messages proceed straight into the photo flow.
    if (event.kind !== "photo") return;
  }

  if (event.kind === "photo") {
    await handlePhoto(event, deps);
    return;
  }

  // An ACTIVE setup wizard wins over a pending draft: the user chose setup, so
  // its replies must not be swallowed by the draft branch. (Drafts stay active
  // and resume once the wizard completes.)
  const setupStep = await deps.businesses.getSetupStep(event.userPhone);
  if (setupStep) {
    await handleSetupReply(event, deps);
    return;
  }

  const draft = await deps.drafts.findActiveDraft(event.userPhone);
  if (draft) {
    await handleDraftReply(event, draft, deps);
    return;
  }

  const reply = await handleCommand(event, {
    config: deps.config,
    drafts: deps.drafts,
    businesses: deps.businesses,
  });
  if (reply !== null) {
    await deps.send.sendText(event.userPhone, reply);
  }
}
