/**
 * Photo ingestion (§5.6): the draft row is created on webhook receipt — before
 * extraction — so a retried delivery can never double-process. A retry finds the
 * existing draft (via the `(user_phone, wa_message_id)` key) and is ignored.
 *
 * §5.8 auto-log (M7): High-confidence, non-machine-read extractions log
 * immediately with the 24-hour undo window, gated on the duplicate check and
 * the business's `auto_save` opt-out.
 */
import { renderConfirmScreen, renderLoggedReply } from "../messaging/screens";
import type { RouteDeps } from "../webhook/router";
import type { InboundEvent } from "../types";
import { resolveBusiness } from "./helpers";

export async function handlePhoto(event: InboundEvent, deps: RouteDeps): Promise<void> {
  const flowExpiresAt = new Date(Date.now() + deps.config.ttl.draftMinutes * 60_000);

  const draft = await deps.drafts.createDraft({
    userPhone: event.userPhone,
    waMessageId: event.waMessageId,
    imageUrls: event.imageUrls ?? [],
    flowExpiresAt,
  });

  if (draft === null) {
    // Retried delivery — already processed. Do not re-acknowledge or re-extract.
    return;
  }

  await deps.send.sendText(event.userPhone, "📸 Received. Reading...");

  const business = await resolveBusiness(deps, event.userPhone);

  // M8: fetch the image bytes from WhatsApp and archive them to the `bills`
  // bucket (§5.5) at business_id/YYYY/MM/. No parser reads the bytes in the
  // Workers AI architecture (the model is text-only and there is no server-side
  // OCR) — a photo without OCR text lands on the manual-entry prompt, which is
  // exactly the §5.3 fallback for an unreadable image.
  let imageBytes: Uint8Array | undefined;
  let imageMimeType: string | undefined;
  // Drafts start holding the WhatsApp media IDs; storage URLs replace them when
  // the upload lands, and stay as IDs if archival fails (non-fatal).
  let imageUrls: string[] = draft.imageUrls;
  const mediaId = event.imageUrls?.[0];
  if (mediaId) {
    try {
      const media = await deps.send.downloadMedia(mediaId);
      imageBytes = media.bytes;
      imageMimeType = media.mimeType;
      if (business) {
        try {
          const stored = await deps.storage.uploadBill(business.id, media.bytes, media.mimeType, {
            mediaId,
          });
          imageUrls = [stored.url];
        } catch {
          // Archival failure — extraction still runs on the bytes in hand.
        }
      }
    } catch {
      // Media download failed — proceed without bytes (regex/text fallback, §5.3).
    }
  }

  const outcome = await deps.extraction.run({
    text: event.text ?? "",
    ocrText: event.ocrText,
    imageBytes,
    imageMimeType,
    gstRegistered: business?.gstRegistered ?? true,
  });

  // §5.8 auto-log: High confidence, not machine-read, auto_save on, no duplicate.
  if (
    outcome.gate === "high" &&
    !outcome.machineRead &&
    business?.autoSave !== false
  ) {
    const within90 = new Date(Date.now() - 90 * 24 * 3_600_000);
    const duplicate = await deps.drafts.findDuplicate(
      event.userPhone,
      outcome.extraction,
      within90,
    );
    if (!duplicate) {
      // Persist the extraction first so the logged reply and audit trail carry it.
      await deps.drafts.setFlowState(draft.id, {
        flowState: "awaiting_confirm",
        extraction: outcome.extraction,
        gateLevel: outcome.gate,
        machineRead: outcome.machineRead,
        imageUrls,
      });
      const confirmed = await deps.drafts.confirm(draft.id, new Date(), { autoLogged: true });
      if (confirmed) {
        await deps.send.sendText(event.userPhone, renderLoggedReply(confirmed, "24 hours"));
        return;
      }
    }
    // Duplicate suspected → fall through to the confirm screen (§4.1 edge case).
  }

  const updated = await deps.drafts.setFlowState(draft.id, {
    flowState: "awaiting_confirm",
    extraction: outcome.extraction,
    gateLevel: outcome.gate,
    machineRead: outcome.machineRead,
    imageUrls,
  });

  await deps.send.sendText(event.userPhone, renderConfirmScreen(updated, deps.config));
}
