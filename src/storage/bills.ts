/**
 * Bill image storage (M8, §5.5/§5.6). Uploads the WhatsApp-downloaded bytes to
 * the Cloudflare R2 `BILLS` bucket at `business_id/YYYY/MM/{mediaId}.{ext}` —
 * the tenant-scoped path from §5.5 so share links and multi-user access are
 * trivial.
 *
 * Archival only: extraction runs on the bytes already in hand, so an upload
 * failure must never block the bill flow (the photo flow treats it as
 * non-fatal and keeps the media IDs on the draft).
 *
 * URLs are same-origin paths (`/bills/{path}`) served by the worker's GET
 * route from the bucket — no public-bucket / custom-domain setup needed.
 */
export interface UploadedBill {
  /** Storage path, e.g. `11111111-1111-4111-8111-111111111111/2026/08/MEDIA-1.jpg`. */
  path: string;
  /** Same-origin URL served from the R2 bucket (`/bills/{path}`) — for re-reads and the accountant export (§5.5). */
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

/** The narrow R2 surface the store uses — the real R2Bucket binding satisfies it. */
export interface R2Like {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
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

export function createR2BillStorage(bucket: R2Like): BillStorage {
  return new R2BillStorage(bucket);
}

class R2BillStorage implements BillStorage {
  constructor(private readonly bucket: R2Like) {}

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

    await this.bucket.put(path, bytes, { httpMetadata: { contentType: mimeType } });
    return { path, url: `/bills/${path}` };
  }
}
