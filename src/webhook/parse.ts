/**
 * WhatsApp Cloud API payload → normalised InboundEvent (§5.6).
 *
 * Returns `null` for anything that is not a user message (status updates, read
 * receipts, malformed payloads) — the webhook acknowledges those with 200 and
 * ignores them so Meta does not retry.
 *
 * Only the first message of the first change is returned; multi-image queueing
 * is handled later by the photo flow (M4).
 */
import type { InboundEvent } from "../types";

export function parseInbound(raw: string): InboundEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const message = firstUserMessage(payload as Record<string, unknown>);
  if (!message) return null;

  const from = typeof message.from === "string" ? message.from : "";
  const id = typeof message.id === "string" ? message.id : "";
  const timestamp = typeof message.timestamp === "string" ? message.timestamp : "";
  const type = typeof message.type === "string" ? message.type : "";

  if (!from || !id) return null;

  const base = {
    userPhone: from,
    waMessageId: id,
    waReceivedAt: new Date(timestamp === "" ? 0 : Number(timestamp) * 1000),
  };

  if (type === "text") {
    const body = message.text as { body?: unknown } | undefined;
    if (typeof body?.body !== "string") return null;
    return { ...base, kind: "text", text: body.body };
  }

  if (type === "image") {
    const image = message.image as { id?: unknown; mime_type?: unknown } | undefined;
    if (typeof image?.id !== "string") return null;
    // Media ID at this stage; the photo flow (M4/M8) downloads it and swaps in
    // the R2 storage URL.
    return { ...base, kind: "photo", imageUrls: [image.id] };
  }

  // Other types (audio, video, document, location, sticker, ...) are ignored for MVP.
  return null;
}

function firstUserMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const entry = asArray(payload.entry)[0];
  if (!entry) return null;
  const change = asArray((entry as Record<string, unknown>).changes)[0];
  if (!change) return null;
  const value = (change as Record<string, unknown>).value;
  if (typeof value !== "object" || value === null) return null;
  const messages = asArray((value as Record<string, unknown>).messages);
  const message = messages[0];
  if (typeof message !== "object" || message === null) return null;
  return message as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
