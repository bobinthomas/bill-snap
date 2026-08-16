/**
 * MockWhatsAppClient — same Messenger interface as the real sender, but it
 * records sends instead of hitting the Graph API, so flow tests run without Meta.
 *
 * Media downloads (M8) serve configurable fixtures from `media`; any media ID
 * listed in `failMediaIds` throws, simulating a dead/expired WhatsApp media link.
 */
import type { DownloadedMedia, Messenger } from "./whatsapp";

export interface SentMessage {
  to: string;
  text: string;
}

export interface MockMessenger extends Messenger {
  sent: SentMessage[];
  downloaded: string[];
}

export interface MockMessengerOptions {
  media?: Record<string, DownloadedMedia>;
  failMediaIds?: string[];
}

export function createMockMessenger(options: MockMessengerOptions = {}): MockMessenger {
  const sent: SentMessage[] = [];
  const downloaded: string[] = [];
  const failMediaIds = new Set(options.failMediaIds ?? []);
  const media = options.media ?? {};

  return {
    sent,
    downloaded,
    async sendText(to, text) {
      sent.push({ to, text });
    },
    async downloadMedia(mediaId) {
      downloaded.push(mediaId);
      if (failMediaIds.has(mediaId)) {
        throw new Error(`mock: media ${mediaId} unavailable`);
      }
      const found = media[mediaId];
      if (!found) {
        throw new Error(`mock: no fixture for media ${mediaId}`);
      }
      return { bytes: new Uint8Array(found.bytes), mimeType: found.mimeType };
    },
  };
}
