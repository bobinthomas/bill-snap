import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createMockWorkersAiExtractor, hashBytes } from "../src/extraction/mock";
import { createExtractionService } from "../src/extraction/pipeline";

describe("mock Workers AI extractor (dev-only, GEMINI_MOCK)", () => {
  it("is deterministic per OCR text and returns realistic high-confidence fields", async () => {
    const extractor = createMockWorkersAiExtractor();
    const text = "RELIANCE HYPERMART LIMITED MADURAI IN";
    const first = await extractor.extractFromText(text);
    const second = await extractor.extractFromText(text);

    expect(first).toEqual(second);
    expect(first.vendor.value).not.toBeNull();
    expect(first.amount.value).toBeGreaterThan(0);
    expect(first.date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.amount.confidence).toBeGreaterThan(0.9);
    expect(first.vendor.confidence).toBeGreaterThan(0.9);
  });

  it("spreads different readings across the bill set", async () => {
    const extractor = createMockWorkersAiExtractor();
    const vendors = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const out = await extractor.extractFromText(`bill reading number ${i}`);
      vendors.add(out.vendor.value ?? "");
    }
    expect(vendors.size).toBeGreaterThan(1);
  });

  it("runs the AI fallback through the pipeline as a trusted reading (auto-log eligible)", async () => {
    // OCR text with NO amount → regex cannot extract → the mock AI fallback
    // takes over (source "ai"). AI is the §5.8 trusted parser: not machine-read,
    // so a High reading auto-logs with the 24 h undo window instead of landing
    // on a confirm screen.
    const config = loadConfig({ GEMINI_MOCK: "true" });
    const service = createExtractionService(config);
    const outcome = await service.run({
      ocrText: "HDFC BANK RELIANCE HYPERMART LIMITED MADURAI IN SALE CARD SWIPE",
    });
    expect(outcome.source).toBe("ai");
    expect(outcome.machineRead).toBe(false);
    expect(outcome.gate).toBe("high");
    expect(outcome.extraction.amount.value).not.toBeNull();
    expect(outcome.extraction.vendor.value).not.toBeNull();
  });

  it("reads photo bytes through the mock vision path as a trusted reading", async () => {
    // A photo with image bytes but no OCR text (the real webhook shape) hits
    // the vision path — the mock hashes the bytes and returns a canned bill.
    const config = loadConfig({ GEMINI_MOCK: "true" });
    const service = createExtractionService(config);
    const bytes = new TextEncoder().encode("fixture-jpeg-bytes");
    const outcome = await service.run({ imageBytes: bytes, imageMimeType: "image/jpeg" });
    expect(outcome.source).toBe("ai");
    expect(outcome.machineRead).toBe(false); // vision AI is trusted (§5.8)
    expect(outcome.gate).toBe("high");
    expect(outcome.extraction.amount.value).not.toBeNull();
    expect(outcome.extraction.vendor.value).not.toBeNull();
  });

  it("is NOT used when the flag is unset (regex stays primary on OCR text)", async () => {
    const config = loadConfig({});
    const service = createExtractionService(config);
    const outcome = await service.run({
      ocrText: "HDFC BANK RELIANCE HYPERMART LIMITED MADURAI IN SALE CARD SWIPE",
    });
    // No mock, no AI binding → regex result stands (machine-read), amount null.
    expect(outcome.machineRead).toBe(true);
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBeNull();
  });

  it("is deterministic via hashBytes", () => {
    const a = hashBytes(new TextEncoder().encode("same text"));
    const b = hashBytes(new TextEncoder().encode("same text"));
    expect(a).toBe(b);
    expect(a).not.toBe(hashBytes(new TextEncoder().encode("other")));
  });
});
