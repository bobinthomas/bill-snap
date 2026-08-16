/**
 * Outbound messaging. The flows depend on the `Messenger` interface so tests
 * can substitute the mock (§7/SCAFFOLDING_PLAN §7). The real sender is a thin,
 * manually-smoked Graph API layer.
 */
import type { AppConfig } from "../config";

/** Downloaded WhatsApp media — bytes ready to feed the extraction pipeline (M8). */
export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export interface Messenger {
  sendText(to: string, text: string): Promise<void>;
  /** Download a WhatsApp media object by its media ID (§5.6, M8). */
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
}

/** Real sender. Returns null from the factory when WhatsApp is not configured. */
export function createWhatsAppMessenger(config: AppConfig): Messenger | null {
  const phoneNumberId = config.whatsapp.phoneNumberId;
  const token = config.whatsapp.token;
  if (!phoneNumberId || !token) return null;
  return new WhatsAppMessenger(phoneNumberId, token);
}

const GRAPH_URL = "https://graph.facebook.com/v21.0";

class WhatsAppMessenger implements Messenger {
  constructor(
    private readonly phoneNumberId: string,
    private readonly token: string,
  ) {}

  async sendText(to: string, text: string): Promise<void> {
    // TODO: bump the Graph API version when Meta rotates it.
    const res = await fetch(`${GRAPH_URL}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp send failed: HTTP ${res.status}`);
    }
  }

  /** §5.6 media fetch: media ID → { url, mime_type }, then the bytes themselves. */
  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    const res = await fetch(`${GRAPH_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`WhatsApp media lookup failed: HTTP ${res.status}`);
    }

    const meta = (await res.json()) as { url?: unknown; mime_type?: unknown };
    if (typeof meta.url !== "string" || meta.url === "") {
      throw new Error("WhatsApp media response had no download URL");
    }

    const bytesRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!bytesRes.ok) {
      throw new Error(`WhatsApp media download failed: HTTP ${bytesRes.status}`);
    }

    const mimeType = typeof meta.mime_type === "string" && meta.mime_type !== "" ? meta.mime_type : "image/jpeg";
    return { bytes: new Uint8Array(await bytesRes.arrayBuffer()), mimeType };
  }
}
