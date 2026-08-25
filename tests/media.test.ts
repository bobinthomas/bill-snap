import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createExtractionService, type ExtractionInput, type ExtractionOutcome } from "../src/extraction/pipeline";
import { handlePhoto } from "../src/flows/photo";
import { createMockMessenger, type MockMessenger } from "../src/messaging/mock";
import type { BillExtraction, InboundEvent } from "../src/types";
import {
  FakeBillStorage,
  FakeBusinessStore,
  FakeDraftStore,
  FakeTransactionStore,
  FakeUserStore,
} from "./fakes";

const PHONE = "61412345678";
const JPEG_BYTES = new TextEncoder().encode("fake-jpeg-bytes");

/** Records every ExtractionInput so tests can assert bytes/text reached the pipeline. */
class RecordingExtraction {
  inputs: ExtractionInput[] = [];
  constructor(private readonly outcome: ExtractionOutcome) {}
  async run(input: ExtractionInput): Promise<ExtractionOutcome> {
    this.inputs.push(input);
    return this.outcome;
  }
}

const HIGH_EXTRACTION: BillExtraction = {
  amount: { value: 4850, confidence: 0.98 },
  date: { value: "2026-08-01", confidence: 0.95 },
  vendor: { value: "Telstra", confidence: 0.92 },
  abn: { value: "51 824 753 556", confidence: 0.9 },
  gst: { value: 440.91, confidence: 0.9 },
  gst_basis: "inclusive",
  invoice_number: { value: "INV-123", confidence: 0.9 },
  due_date: { value: "2026-08-21", confidence: 0.9 },
  category_hint: { value: "utilities", confidence: 0.9 },
};

function photoEvent(waMessageId: string): InboundEvent {
  return {
    userPhone: PHONE,
    waMessageId,
    waReceivedAt: new Date(1723000000 * 1000),
    kind: "photo",
    imageUrls: ["MEDIA-1"],
  };
}

function makeDeps(outcome: ExtractionOutcome, send: MockMessenger) {
  const config = loadConfig({});
  const users = new FakeUserStore([{ phoneNumber: PHONE, businessId: "biz-1", createdAt: new Date() }]);
  // Seed the business so the photo flow can build the storage path (§5.5).
  const businesses = new FakeBusinessStore(users);
  businesses.addBusiness({
    id: "biz-1",
    name: "My Business",
    abn: null,
    gstNumber: null,
    timezone: "Australia/Sydney",
    gstRegistered: true,
    autoSave: true,
    address: null,
    phone: null,
  });
  const extraction = new RecordingExtraction(outcome);
  const storage = new FakeBillStorage();
  return {
    config,
    extraction,
    storage,
    drafts: new FakeDraftStore(),
    deps: {
      users,
      businesses,
      drafts: new FakeDraftStore(),
      transactions: new FakeTransactionStore(),
      extraction,
      send,
      storage,
      config,
    } as const,
  };
}

describe("M8 media download (§5.6)", () => {
  it("downloads the media and feeds the real bytes to the extractor", async () => {
    const send = createMockMessenger({
      media: { "MEDIA-1": { bytes: JPEG_BYTES, mimeType: "image/jpeg" } },
    });
    const { extraction, storage, deps } = makeDeps(
      { extraction: HIGH_EXTRACTION, gate: "high", machineRead: false, source: "ai" },
      send,
    );

    await handlePhoto(photoEvent("wamid.m8.1"), deps);

    expect(send.downloaded).toEqual(["MEDIA-1"]);
    const input = extraction.inputs[0];
    expect(input?.imageBytes).toEqual(JPEG_BYTES);
    expect(input?.imageMimeType).toBe("image/jpeg");

    // The bytes are archived to the bills bucket at the tenant-scoped path (§5.5),
    // and the storage URL replaces the media ID on the draft.
    expect(storage.uploaded).toEqual([
      { businessId: "biz-1", bytes: JPEG_BYTES, mimeType: "image/jpeg", mediaId: "MEDIA-1" },
    ]);
    const logged = await deps.drafts.findRecentLogged(PHONE, new Date(Date.now() - 60_000));
    expect(logged?.imageUrls).toEqual(["https://cdn.test/bills/biz-1/2026/08/MEDIA-1.jpg"]);

    // High + non-machine-read → §5.8 auto-log with the 24-hour undo window.
    expect(send.sent[0]?.text).toBe("📸 Received. Reading...");
    expect(send.sent[1]?.text).toContain("✅ Logged:");
    expect(send.sent[1]?.text).toContain("within 24 hours to undo");
  });

  it("keeps extracting when the storage upload fails (archival is non-fatal)", async () => {
    const send = createMockMessenger({
      media: { "MEDIA-1": { bytes: JPEG_BYTES, mimeType: "image/jpeg" } },
    });
    const { extraction, storage, deps } = makeDeps(
      { extraction: HIGH_EXTRACTION, gate: "high", machineRead: false, source: "ai" },
      send,
    );
    storage.fail = true;

    await handlePhoto(photoEvent("wamid.m8.5"), deps);

    // Extraction still runs on the bytes; the draft keeps the WhatsApp media IDs.
    expect(extraction.inputs[0]?.imageBytes).toEqual(JPEG_BYTES);
    const logged = await deps.drafts.findRecentLogged(PHONE, new Date(Date.now() - 60_000));
    expect(logged?.imageUrls).toEqual(["MEDIA-1"]);
  });

  it("falls back to the regex path when the media download fails", async () => {
    const send = createMockMessenger({ failMediaIds: ["MEDIA-1"] });
    // The pipeline's fallback outcome: no bytes → regex/none source → machine-read.
    const { extraction, deps } = makeDeps(
      { extraction: HIGH_EXTRACTION, gate: "low", machineRead: true, source: "none" },
      send,
    );

    await handlePhoto(photoEvent("wamid.m8.2"), deps);

    expect(send.downloaded).toEqual(["MEDIA-1"]);
    const input = extraction.inputs[0];
    expect(input?.imageBytes).toBeUndefined();
    expect(input?.imageMimeType).toBeUndefined();

    // Never auto-logs a machine-read outcome — lands on the Variant C screen.
    expect(send.sent[1]?.text).toContain("Machine-read, please verify");
    expect(send.sent[1]?.text).not.toContain("✅ Logged:");
  });

  it("end-to-end: a dead media link still lands on a confirm screen, not an error", async () => {
    const config = loadConfig({});
    const send = createMockMessenger({ failMediaIds: ["MEDIA-1"] });
    const users = new FakeUserStore([{ phoneNumber: PHONE, businessId: "biz-1", createdAt: new Date() }]);
    const businesses = new FakeBusinessStore(users);
    businesses.addBusiness({
      id: "biz-1",
      name: "My Business",
      abn: null,
      gstNumber: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
      address: null,
      phone: null,
    });
    const deps = {
      users,
      businesses,
      drafts: new FakeDraftStore(),
      transactions: new FakeTransactionStore(),
      extraction: createExtractionService(config),
      send,
      storage: new FakeBillStorage(),
      config,
    };

    await handlePhoto(photoEvent("wamid.m8.3"), deps);

    // Real pipeline with no AI binding and no bytes → regex/none → machine-read confirm.
    expect(send.sent[1]?.text).toContain("📄 Bill Read");
    const draft = await deps.drafts.findActiveDraft(PHONE);
    expect(draft?.machineRead).toBe(true);
    expect(draft?.gateLevel).toBe("low");
    // No media → nothing uploaded; the draft keeps the media ID as its URL placeholder.
    expect(draft?.imageUrls).toEqual(["MEDIA-1"]);
  });

  it("a retried photo delivery downloads the media at most once", async () => {
    const send = createMockMessenger({
      media: { "MEDIA-1": { bytes: JPEG_BYTES, mimeType: "image/jpeg" } },
    });
    const { extraction, storage, deps } = makeDeps(
      { extraction: HIGH_EXTRACTION, gate: "high", machineRead: false, source: "ai" },
      send,
    );

    const event = photoEvent("wamid.m8.4");
    await handlePhoto(event, deps);
    const sentAfterFirst = send.sent.length;
    await handlePhoto(event, deps);

    expect(send.downloaded).toEqual(["MEDIA-1"]);
    expect(storage.uploaded).toHaveLength(1);
    expect(extraction.inputs).toHaveLength(1);
    expect(send.sent).toHaveLength(sentAfterFirst);
  });
});
