import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { demoDeps, resetDemo } from "../src/dev/demo";
import { MemoryBillStorage } from "../src/dev/memory";
import { createApp } from "../src/index";

const ENV = { DEV_DEMO: "true" };

interface DemoJson {
  messages: Array<{ from: "user" | "bot"; text: string }>;
  draft: { id: string; flowState: string | null; status: string } | null;
  persistence: "d1" | "in-memory";
  extractor?: string;
  lastRead?: string | null;
}

async function post(app: ReturnType<typeof createApp>, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  );
}

describe("dev demo console (/dev/demo)", () => {
  beforeEach(() => resetDemo());

  it("returns 404 when DEV_DEMO is not set (never leaks to production)", async () => {
    const app = createApp();
    const res = await app.request("/dev/demo", {}, {});
    expect(res.status).toBe(404);
  });

  it("serves the demo page when enabled", async () => {
    const app = createApp();
    const res = await app.request("/dev/demo", {}, ENV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("browser demo");
    expect(html).toContain("Send a bill photo");
  });

  it("runs the photo → confirm → undo round trip through the real router", async () => {
    const app = createApp();

    // Photo: unknown number onboards, gets the welcome, then the confirm screen.
    const photo = await post(app, "/dev/demo/photo");
    expect(photo.status).toBe(200);
    const afterPhoto = (await photo.json()) as DemoJson;
    const photoTexts = afterPhoto.messages.map((m) => m.text);
    expect(afterPhoto.persistence).toBe("in-memory");
    expect(photoTexts.some((t) => t.includes("Welcome to BillSnap"))).toBe(true);
    expect(photoTexts.some((t) => t.includes("Received. Reading"))).toBe(true);
    expect(photoTexts.some((t) => t.includes("📄 Bill Read"))).toBe(true);
    expect(afterPhoto.draft?.flowState).toBe("awaiting_confirm");

    // Confirm with 1️⃣.
    const confirm = await post(app, "/dev/demo/text", { text: "1" });
    const afterConfirm = (await confirm.json()) as DemoJson;
    expect(afterConfirm.messages.some((m) => m.text.includes("✅ Logged:"))).toBe(true);
    expect(afterConfirm.draft).toBeNull(); // draft flipped to logged

    // Undo with `delete`.
    const undo = await post(app, "/dev/demo/text", { text: "delete" });
    const afterUndo = (await undo.json()) as DemoJson;
    expect(afterUndo.messages.some((m) => m.text.includes("Undone"))).toBe(true);
  });

  it("surfaces the extraction fields in the demo state", async () => {
    const app = createApp();
    await post(app, "/dev/demo/photo");
    const res = await app.request("/dev/demo/state", {}, ENV);
    const state = (await res.json()) as DemoJson;
    // Fixture bytes never extract — the machine-read confirm shows empty fields.
    expect(state.draft?.status).toBe("draft");
  });

  it("rejects an empty text message", async () => {
    const app = createApp();
    const res = await post(app, "/dev/demo/text", { text: "   " });
    expect(res.status).toBe(400);
  });

  it("auto-logs a mock Workers AI read (High, trusted parser) with the 24 h undo window", async () => {
    const app = createApp();
    const env = { DEV_DEMO: "true", GEMINI_MOCK: "true", DASHBOARD_PASSWORD: "test-password" };
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("img")], "mock-bill.jpg", { type: "image/jpeg" }));
    // OCR text with NO amount → regex cannot extract → the mock AI fallback runs.
    form.append("ocrText", "HDFC BANK RELIANCE HYPERMART LIMITED MADURAI IN SALE CARD SWIPE");

    const res = await app.request("/dev/demo/photo", { method: "POST", body: form }, env);
    expect(res.status).toBe(200);
    const state = (await res.json()) as DemoJson;

    // The demo advertises the canned extractor so a mock read is never mistaken for a real one.
    expect(state.extractor).toBe("mock (canned)");
    expect(state.lastRead).toBe("ai");

    // Workers AI is the §5.8 trusted parser: a High reading auto-logs instead
    // of landing on the confirm screen — the 24 h `delete` window is the net.
    expect(state.messages.some((m) => m.text.includes("✅ Logged"))).toBe(true);
    expect(state.messages.some((m) => m.text.includes("within 24 hours to undo"))).toBe(true);
    expect(state.messages.some((m) => m.text.includes("📄 Bill Read"))).toBe(false);
    expect(state.draft).toBeNull(); // confirmed — no active draft left

    // The dashboard KPI counts the auto-logged bill.
    const dash = await app.request(
      "/dev/dashboard/data",
      { headers: { Authorization: "Basic " + btoa("billsnap:test-password") } },
      env,
    );
    const d = (await dash.json()) as { totals: { count: number; autoLogged: number } };
    expect(d.totals.count).toBe(1);
    expect(d.totals.autoLogged).toBe(1);
  });

  it("reads a photo via local OCR text (browser OCR → pipeline source \"ocr\")", async () => {
    const app = createApp();
    // No mock, no key → the OCR fallback path.
    const env = { DEV_DEMO: "true" };
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("img")], "bill.png", { type: "image/png" }));
    form.append("ocrText", "internet 99.95 telstra gst");

    const res = await app.request("/dev/demo/photo", { method: "POST", body: form }, env);
    expect(res.status).toBe(200);
    const state = (await res.json()) as DemoJson;

    // The demo records the actual reading source.
    expect(state.lastRead).toBe("ocr");
    expect(state.extractor).toContain("local OCR");
    // Machine-read confirm screen with the fields the OCR text produced.
    expect(state.messages.some((m) => m.text.includes("telstra"))).toBe(true);
    expect(state.messages.some((m) => m.text.includes("$99.95"))).toBe(true);
    expect(state.draft?.flowState).toBe("awaiting_confirm");
  });

  it("echoes the raw OCR lines with the extracted total after a photo", async () => {
    const app = createApp();
    const env = { DEV_DEMO: "true" };
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("img")], "sample-bill.png", { type: "image/png" }));
    // The sample-bill shape: Subtotal/GST lines and a split-line Total.
    form.append(
      "ocrText",
      "Origin Energy\n10/08/2026\nSubtotal: $243.00\nGST: $24.30\nTotal:\n$267.30",
    );
    form.append("ocrConfig", "sparse (PSM 6)");

    const res = await app.request("/dev/demo/photo", { method: "POST", body: form }, env);
    expect(res.status).toBe(200);
    const state = (await res.json()) as DemoJson;

    const read = state.messages.find((m) => m.text.includes("OCR read"));
    expect(read).toBeDefined();
    // The captured fields are listed above the raw lines — the amount picker
    // chose the Total (via the line below the label), not the subtotal.
    expect(read!.text).toContain("OCR read — sparse (PSM 6)");
    expect(read!.text).toContain('Amount: $267.30 (from line "$267.30")');
    expect(read!.text).toContain("Date: 2026-08-10");
    expect(read!.text).toContain("Vendor: Origin");
    expect(read!.text).toContain("Raw lines:");
    expect(read!.text).toContain("Subtotal: $243.00");
    // The machine-read confirm screen still follows the read-back.
    expect(state.messages.some((m) => m.text.includes("📄 Bill Read"))).toBe(true);
    expect(state.draft?.flowState).toBe("awaiting_confirm");
  });

  it("routes a real uploaded image through the pipeline (M8 real bytes)", async () => {
    const app = createApp();
    const bytes = new TextEncoder().encode("fake-jpeg-bytes");
    const form = new FormData();
    form.append("file", new File([bytes], "cat-bill.jpg", { type: "image/jpeg" }));

    const res = await app.request("/dev/demo/photo", { method: "POST", body: form }, ENV);
    expect(res.status).toBe(200);
    const state = (await res.json()) as DemoJson;

    // The chat shows the chosen filename.
    expect(state.messages.some((m) => m.text.includes("cat-bill.jpg"))).toBe(true);
    // The photo flow ran — machine-read confirm screen (no AI binding here).
    expect(state.messages.some((m) => m.text.includes("📄 Bill Read"))).toBe(true);
    expect(state.draft?.flowState).toBe("awaiting_confirm");

    // The real bytes reached the storage upload (not the fixture).
    const deps = demoDeps(loadConfig(ENV));
    const storage = deps.storage as MemoryBillStorage;
    const upload = storage.uploaded.find((u) => u.mimeType === "image/jpeg");
    expect(upload).toBeDefined();
    expect(upload?.bytes).toEqual(bytes);
  });
});
