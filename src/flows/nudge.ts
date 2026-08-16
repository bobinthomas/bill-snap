/**
 * Nudge + expiry sweep (cron, §5.6/§6.2).
 *
 * Fires periodically and:
 * 1. flips drafts past `flow_expires_at` to `expired`;
 * 2. sends the confirm-screen nudge to drafts still awaiting a reply — one nudge
 *    per draft (`flow_nudged_at` cap), timed so the user has ~4 minutes to act
 *    before the 10-minute expiry.
 *
 * The nudge fires inside WhatsApp's 24-hour service window (the user messaged
 * minutes earlier), so it needs no pre-approved template.
 */
import { NUDGE_TEXT } from "../messaging/screens";
import type { RouteDeps } from "../webhook/router";

export interface SweepResult {
  nudged: number;
  expired: number;
}

export async function runSweep(deps: RouteDeps): Promise<SweepResult> {
  const now = new Date();

  const expired = await deps.drafts.expireDue(now);

  // Nudge window: the tail of the draft TTL, e.g. last 4 minutes of a 10-minute
  // draft when the nudge delay is 6 minutes.
  const nudgeWindowMs =
    (deps.config.ttl.draftMinutes - deps.config.ttl.nudgeDelayMinutes) * 60_000;
  const due = await deps.drafts.findNudgeDue(now, nudgeWindowMs);

  for (const draft of due) {
    await deps.send.sendText(draft.userPhone, NUDGE_TEXT);
    await deps.drafts.markNudged(draft.id, now);
  }

  return { nudged: due.length, expired };
}
