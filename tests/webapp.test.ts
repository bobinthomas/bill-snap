import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { resetWebApp, type WebAppState } from "../src/webapp/app";

const ENV = {};

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

/** The webapp photo endpoint is multipart — build the form the page sends. */
function photoForm(device: string, file?: File, ocrText?: string) {
  const form = new FormData();
  form.append("device", device);
  if (file) form.append("file", file);
  if (ocrText) form.append("ocrText", ocrText);
  return form;
}

describe("mobile-first webapp (/app)", () => {
  beforeEach(() => resetWebApp());

  it("serves the webapp page without DEV_DEMO (it is the primary flow)", async () => {
    const app = createApp();
    const res = await app.request("/app", {}, ENV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Take photo");
    expect(html).toContain("Delete ·");
    expect(html).not.toContain("Debug info");
    expect(html).not.toContain("Try a sample bill");
    expect(html).toContain("billsnap.device");
  });

  it("requires a device id on state/photo/action", async () => {
    const app = createApp();
    expect((await app.request("/app/state", {}, ENV)).status).toBe(400);
    expect((await post(app, "/app/action", { text: "1" })).status).toBe(400);
  });

  it("runs photo → confirm → undo through the real router with a device identity", async () => {
    const app = createApp();
    const device = "web_test_1";

    // Photo with OCR text: unknown device auto-onboards (business + user), then
    // the photo flow creates a draft and shows the machine-read confirm screen.
    const photo = await app.request(
      "/app/photo",
      { method: "POST", body: photoForm(device, undefined, "internet 99.95 telstra gst") },
      ENV,
    );
    expect(photo.status).toBe(200);
    const afterPhoto = (await photo.json()) as WebAppState;
    expect(afterPhoto.persistence).toBe("in-memory");
    expect(afterPhoto.draft?.flowState).toBe("awaiting_confirm");
    expect(afterPhoto.draft?.extraction?.amount).toBe(99.95);
    expect(afterPhoto.draft?.extraction?.vendor).toBe("telstra");
    expect(afterPhoto.draft?.machineRead).toBe(true);

    // Confirm with 1️⃣.
    const confirm = await post(app, "/app/action", { device, text: "1" });
    const afterConfirm = (await confirm.json()) as WebAppState;
    expect(afterConfirm.draft).toBeNull(); // flipped to logged
    expect(afterConfirm.lastReply).toContain("✅ Logged");
    expect(afterConfirm.recent.length).toBe(1);
    expect(afterConfirm.recent[0]!.amount).toBe(99.95);
    expect(afterConfirm.recent[0]!.deleteUntil).toBeTruthy();

    // Delete from the recent list within the webapp's two-hour window.
    const undo = await post(app, "/app/action", {
      device,
      text: "delete:" + afterConfirm.recent[0]!.id,
    });
    const afterUndo = (await undo.json()) as WebAppState;
    expect(afterUndo.lastReply).toContain("Deleted");
    expect(afterUndo.recent.length).toBe(0);
  });

  it("supports the edit sub-flow (option 2 → value → re-rendered confirm)", async () => {
    const app = createApp();
    const device = "web_test_edit";

    await app.request("/app/photo", { method: "POST", body: photoForm(device, undefined, "coffee shop") }, ENV);

    // Option 2 → editing_amount.
    const edit = await post(app, "/app/action", { device, text: "2" });
    const afterEdit = (await edit.json()) as WebAppState;
    expect(afterEdit.draft?.flowState).toBe("editing_amount");

    // The corrected value is validated and re-applied → confirm screen re-renders.
    const value = await post(app, "/app/action", { device, text: "12.50" });
    const afterValue = (await value.json()) as WebAppState;
    expect(afterValue.draft?.flowState).toBe("awaiting_confirm");
    expect(afterValue.draft?.extraction?.amount).toBe(12.5);

    // Confirm saves the edited bill.
    await post(app, "/app/action", { device, text: "1" });
    const stateRes = await app.request(`/app/state?device=${device}`, {}, ENV);
    const state = (await stateRes.json()) as WebAppState;
    expect(state.recent[0]?.amount).toBe(12.5);
  });

  it("isolates bills between devices", async () => {
    const app = createApp();
    await app.request("/app/photo", { method: "POST", body: photoForm("web_a", undefined, "rent 2200 homebase") }, ENV);
    await post(app, "/app/action", { device: "web_a", text: "1" });

    const otherRes = await app.request("/app/state?device=web_b", {}, ENV);
    const other = (await otherRes.json()) as WebAppState;
    expect(other.recent.length).toBe(0);
    expect(other.draft).toBeNull();
  });

  it("shares the store with the dashboard (device-scoped analytics)", async () => {
    const app = createApp();
    await app.request("/app/photo", { method: "POST", body: photoForm("web_dash", undefined, "internet 100 telstra gst") }, ENV);
    await post(app, "/app/action", { device: "web_dash", text: "1" });

    // The webapp's own recent list has the bill.
    const stateRes = await app.request("/app/state?device=web_dash", {}, ENV);
    const state = (await stateRes.json()) as WebAppState;
    expect(state.recent.length).toBe(1);

    // The dashboard scoped to that device sees it; the demo user does not.
    const devEnv = { DEV_DEMO: "true", DASHBOARD_PASSWORD: "test-password" };
    const authHeader = { headers: { Authorization: "Basic " + btoa("billsnap:test-password") } };
    const dashRes = await app.request("/dev/dashboard/data?device=web_dash", authHeader, devEnv);
    const dash = (await dashRes.json()) as { totals: { count: number; amount: number } };
    expect(dash.totals.count).toBe(1);
    expect(dash.totals.amount).toBe(100);

    const otherRes = await app.request("/dev/dashboard/data", authHeader, devEnv);
    const other = (await otherRes.json()) as { totals: { count: number } };
    expect(other.totals.count).toBe(0);
  });

  it("learns vendors from logged bills and canonicalises a mangled re-read", async () => {
    const app = createApp();
    const device = "web_learn";

    // Log a bill from a merchant NOT in the seed KNOWN_VENDORS list.
    await app.request(
      "/app/photo",
      { method: "POST", body: photoForm(device, undefined, "wagh and sons plumbing\nTotal $600.00") },
      ENV,
    );
    await post(app, "/app/action", { device, text: "1" });

    // Second bill from the same merchant, OCR-mangled one character per word:
    // the learned "wagh and sons plumbing" must canonicalise the re-read.
    const photo2 = await app.request(
      "/app/photo",
      { method: "POST", body: photoForm(device, undefined, "WAGH AND SONS PLUMBINQ\nTotal $100.00") },
      ENV,
    );
    const state2 = (await photo2.json()) as WebAppState;
    expect(state2.draft?.extraction?.amount).toBe(100);
    expect(state2.draft?.extraction?.vendor).toBe("wagh and sons plumbing");
  });

  it("logs the vendor resolution on the dashboard for canonicalised bills", async () => {
    const app = createApp();
    const device = "web_resolved";

    // A bill whose vendor is canonicalised via edit-distance matching (seed
    // vendor "Gujarat Freight Tools").
    await app.request(
      "/app/photo",
      { method: "POST", body: photoForm(device, undefined, "GUJARAT FRlGHT TOOLS\nTotal $4490.00") },
      ENV,
    );
    const afterPhotoRes = await app.request("/app/state?device=" + device, {}, ENV);
    const afterPhoto = (await afterPhotoRes.json()) as WebAppState;
    expect(afterPhoto.draft?.extraction?.vendor).toBe("Gujarat Freight Tools");
    await post(app, "/app/action", { device, text: "1" });

    // The dashboard scoped to that device shows the canonical name AND the
    // resolved-to log (which known vendor it was canonicalised to).
    const devEnv = { DEV_DEMO: "true", DASHBOARD_PASSWORD: "test-password" };
    const authHeader = { headers: { Authorization: "Basic " + btoa("billsnap:test-password") } };
    const dashRes = await app.request("/dev/dashboard/data?device=" + device, authHeader, devEnv);
    const dash = (await dashRes.json()) as {
      totals: { count: number };
      recent: Array<{ vendor: string | null; vendorResolvedTo: string | null }>;
    };
    expect(dash.totals.count).toBe(1);
    expect(dash.recent[0]?.vendor).toBe("Gujarat Freight Tools");
    expect(dash.recent[0]?.vendorResolvedTo).toBe("Gujarat Freight Tools");
  });

  it("routes a real uploaded image through the pipeline (bytes + storage)", async () => {
    const app = createApp();
    const bytes = new TextEncoder().encode("fake-web-bill-jpeg");
    const file = new File([bytes], "web-bill.jpg", { type: "image/jpeg" });

    const res = await app.request("/app/photo", { method: "POST", body: photoForm("web_img", file) }, ENV);
    expect(res.status).toBe(200);
    const state = (await res.json()) as WebAppState;
    // No OCR text, no AI binding → machine-read confirm screen.
    expect(state.draft?.flowState).toBe("awaiting_confirm");
    expect(state.draft?.machineRead).toBe(true);
  });
});
