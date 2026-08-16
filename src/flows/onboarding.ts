/**
 * Onboarding for unknown numbers (§4.5): auto-create users + businesses +
 * owner membership with sensible defaults, send the welcome, and run the
 * `setup` wizard (business name → timezone → GST).
 */
import {
  SETUP_DONE_TEXT,
  SETUP_GST_PROMPT,
  SETUP_GST_RETRY,
  SETUP_NAME_PROMPT,
  SETUP_NAME_RETRY,
  SETUP_TIMEZONE_PROMPT,
  SETUP_TIMEZONE_RETRY,
  WELCOME_TEXT,
} from "../messaging/screens";
import type { InboundEvent } from "../types";
import type { RouteDeps } from "../webhook/router";

const TIMEZONES: Record<string, string> = {
  sydney: "Australia/Sydney",
  melbourne: "Australia/Sydney",
  canberra: "Australia/Sydney",
  hobart: "Australia/Hobart",
  brisbane: "Australia/Brisbane",
  adelaide: "Australia/Adelaide",
  darwin: "Australia/Darwin",
  perth: "Australia/Perth",
};

/** First contact (§4.5). Auto-creates the business rows, then welcomes. */
export async function handleOnboarding(event: InboundEvent, deps: RouteDeps): Promise<void> {
  await deps.businesses.onboard(event.userPhone);
  await deps.send.sendText(event.userPhone, WELCOME_TEXT);
}

/** Advances the §4.5 settings wizard on the user's reply. */
export async function handleSetupReply(event: InboundEvent, deps: RouteDeps): Promise<void> {
  const step = await deps.businesses.getSetupStep(event.userPhone);
  if (!step) return;

  const text = (event.text ?? "").trim();
  const skip = text.toLowerCase() === "skip";
  const user = await deps.users.findUser(event.userPhone);
  const business = user?.businessId ? await deps.businesses.findBusiness(user.businessId) : null;
  if (!business) {
    await deps.businesses.setSetupStep(event.userPhone, null);
    return;
  }

  if (step === "name") {
    if (!skip) {
      if (text === "" || text.length > 60) {
        await deps.send.sendText(event.userPhone, SETUP_NAME_RETRY);
        return;
      }
      await deps.businesses.updateBusiness(business.id, { name: text });
    }
    await deps.businesses.setSetupStep(event.userPhone, "timezone");
    await deps.send.sendText(event.userPhone, SETUP_TIMEZONE_PROMPT);
    return;
  }

  if (step === "timezone") {
    const tz = skip ? undefined : TIMEZONES[text.toLowerCase()];
    if (!skip && tz === undefined) {
      await deps.send.sendText(event.userPhone, SETUP_TIMEZONE_RETRY);
      return;
    }
    if (tz !== undefined) await deps.businesses.updateBusiness(business.id, { timezone: tz });
    await deps.businesses.setSetupStep(event.userPhone, "gst");
    await deps.send.sendText(event.userPhone, SETUP_GST_PROMPT);
    return;
  }

  // gst step
  const low = text.toLowerCase();
  if (low === "yes") {
    await deps.businesses.updateBusiness(business.id, { gstRegistered: true });
  } else if (low === "no") {
    await deps.businesses.updateBusiness(business.id, { gstRegistered: false });
  } else if (!skip) {
    await deps.send.sendText(event.userPhone, SETUP_GST_RETRY);
    return;
  }
  await deps.businesses.setSetupStep(event.userPhone, null);
  await deps.send.sendText(event.userPhone, SETUP_DONE_TEXT);
}
