/**
 * Photo ingestion (§5.6): the draft row is created on webhook receipt — before
 * extraction — so a retried delivery can never double-process. A retry finds the
 * existing draft (via the `(user_phone, wa_message_id)` key) and is ignored.
 *
 * Duplicate detection (business-scoped, unconditional — see drafts.ts's
 * findDuplicateForBusiness) runs first, ahead of everything else below: a
 * match short-circuits straight to `awaiting_duplicate_confirm`, skipping
 * both auto-log and the ordinary confirm screen.
 *
 * §5.8 auto-log (M7): High-confidence, non-machine-read extractions log
 * immediately with the 24-hour undo window, gated on the business's
 * `auto_save` opt-out (duplicate avoidance already happened above).
 */
import { renderConfirmScreen, renderDuplicateConfirmScreen, renderLoggedReply } from "../messaging/screens";
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

  // Episodic memory (§extraction/vendor-categories): this business's own
  // confirmed vendor->category history, used to pre-fill category_hint when
  // this bill's own text/model read didn't find one.
  const vendorCategoryHistory = business
    ? await deps.transactions.getVendorCategoryHistory(business.id)
    : undefined;

  const outcome = await deps.extraction.run({
    text: event.text ?? "",
    ocrText: event.ocrText,
    imageBytes,
    imageMimeType,
    gstRegistered: business?.gstRegistered ?? true,
    vendorCategoryHistory,
  });

  // Business-scoped duplicate check (§dev/dashboard bills, drafts.ts's
  // findDuplicateForBusiness) — unconditional, not just an auto-log gate:
  // multi-device-per-company makes a cross-device duplicate the common case,
  // not an edge case. No time window; skipped when extraction couldn't read
  // an amount/date, or no business is resolved yet.
  const candidateAmount = outcome.extraction.amount.value;
  const candidateBillDate = outcome.extraction.date.value;
  if (business && candidateAmount !== null && candidateBillDate !== null) {
    const existing = await deps.drafts.findDuplicateForBusiness(business.id, {
      amount: candidateAmount,
      billDate: candidateBillDate,
      excludeId: draft.id,
    });
    if (existing) {
      await deps.drafts.setFlowState(draft.id, {
        flowState: "awaiting_duplicate_confirm",
        extraction: outcome.extraction,
        gateLevel: outcome.gate,
        machineRead: outcome.machineRead,
        imageUrls,
        businessId: business.id,
        duplicateOfId: existing.id,
      });
      await deps.send.sendText(event.userPhone, renderDuplicateConfirmScreen(existing));
      return;
    }
  }

  // §5.8 auto-log: High confidence, not machine-read, auto_save on. Duplicate
  // avoidance already happened above, business-scoped and unconditional.
  if (
    outcome.gate === "high" &&
    !outcome.machineRead &&
    business?.autoSave !== false
  ) {
    // Persist the extraction first so the logged reply and audit trail carry it.
    await deps.drafts.setFlowState(draft.id, {
      flowState: "awaiting_confirm",
      extraction: outcome.extraction,
      gateLevel: outcome.gate,
      machineRead: outcome.machineRead,
      imageUrls,
      businessId: business?.id,
    });
    const confirmed = await deps.drafts.confirm(draft.id, new Date(), { autoLogged: true });
    if (confirmed) {
      await deps.send.sendText(event.userPhone, renderLoggedReply(confirmed, "24 hours"));
      return;
    }
  }

  const updated = await deps.drafts.setFlowState(draft.id, {
    flowState: "awaiting_confirm",
    extraction: outcome.extraction,
    gateLevel: outcome.gate,
    machineRead: outcome.machineRead,
    imageUrls,
    businessId: business?.id,
  });

  await deps.send.sendText(event.userPhone, renderConfirmScreen(updated, deps.config));
}
