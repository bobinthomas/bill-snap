/**
 * Bill image storage (M8, §5.5/§5.6). Uploads the WhatsApp-downloaded bytes to
 * the Supabase `bills` bucket at `business_id/YYYY/MM/{mediaId}.{ext}` — the
 * tenant-scoped path from §5.5 so share links and multi-user access are trivial.
 *
 * Archival only: extraction runs on the bytes already in hand, so an upload
 * failure must never block the bill flow (the photo flow treats it as
 * non-fatal and keeps the media IDs on the draft).
 */
import type { AppConfig } from "../config";

export interface UploadedBill {
  /** Storage path, e.g. `11111111-1111-4111-8111-111111111111/2026/08/MEDIA-1.jpg`. */
  path: string;
  /** Public URL for re-reads and the accountant export (§5.5). */
  url: string;
}

export interface UploadBillOptions {
  /** Originating WhatsApp media ID — used for the filename. */
  mediaId: string;
}

export interface BillStorage {
  uploadBill(
    businessId: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadBillOptions,
  ): Promise<UploadedBill>;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/** Media IDs are untrusted webhook input (§7.2) — keep only safe filename chars. */
function sanitize(mediaId: string): string {
  const cleaned = mediaId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned === "" ? "bill" : cleaned;
}

export function createSupabaseBillStorage(
  config: AppConfig,
  fetchFn?: typeof fetch,
): BillStorage | null {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) return null;
  return new SupabaseBillStorage(config.supabase.url, config.supabase.serviceRoleKey, fetchFn ?? fetch);
}

class SupabaseBillStorage implements BillStorage {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async uploadBill(
    businessId: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadBillOptions,
  ): Promise<UploadedBill> {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const path = `${businessId}/${yyyy}/${mm}/${sanitize(opts.mediaId)}.${MIME_EXT[mimeType] ?? "jpg"}`;

    const res = await this.fetchFn(`${this.url}/storage/v1/object/bills/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": mimeType,
      },
      body: bytes,
    });
    if (!res.ok) {
      throw new Error(`Supabase storage upload failed: HTTP ${res.status}`);
    }

    return { path, url: `${this.url}/storage/v1/object/public/bills/${path}` };
  }
}
