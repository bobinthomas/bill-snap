import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { billsToCsv, exportFileName, type LoggedBill } from "../src/dev/dashboard";
import { demoDeps, DEMO_PHONE, resetDemo } from "../src/dev/demo";
import { createApp } from "../src/index";

const DASHBOARD_PASSWORD = "test-password";
const ENV = { DEV_DEMO: "true", DASHBOARD_PASSWORD };
const AUTH_HEADER = { Authorization: "Basic " + btoa(`billsnap:${DASHBOARD_PASSWORD}`) };

interface DashboardJson {
  persistence: "d1" | "in-memory";
  totals: { count: number; amount: number; gst: number; autoLogged: number; manual: number };
  categories: Array<{ category: string; count: number; amount: number }>;
  vendors: Array<{ vendor: string; count: number; amount: number }>;
  days: Array<{ date: string; count: number; amount: number }>;
  months: string[];
  categoryOptions: string[];
  vendorOptions: string[];
  filters: { month: string | null; category: string | null; vendor: string | null };
  recent: Array<{
    confirmedAt: string;
    vendor: string | null;
    category: string;
    amount: number | null;
    gst: number | null;
    autoLogged: boolean;
  }>;
}

async function data(app: ReturnType<typeof createApp>, query = "") {
  const res = await app.request("/dev/dashboard/data" + query, { headers: AUTH_HEADER }, ENV);
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardJson;
}

/** Log a single bill directly through the real stores with a fixed confirmedAt. */
async function logBill(text: string, confirmedAt: Date): Promise<void> {
  await logBillAs(DEMO_PHONE, text, confirmedAt);
}

/** Same as logBill, but for an arbitrary phone/device — and returns the
 *  transaction id (admin bills-table tests need it for edit/delete URLs). */
async function logBillAs(phone: string, text: string, confirmedAt: Date): Promise<string> {
  const deps = demoDeps(loadConfig(ENV));
  const outcome = await deps.extraction.run({ text });
  const draft = await deps.drafts.createDraft({
    userPhone: phone,
    waMessageId: `wamid.test.${phone}.${text}.${confirmedAt.getTime()}`,
    imageUrls: [],
    flowExpiresAt: new Date(Date.now() + 10 * 60_000),
  });
  expect(draft).not.toBeNull();
  await deps.drafts.setFlowState(draft!.id, {
    flowState: "awaiting_confirm",
    extraction: outcome.extraction,
    gateLevel: outcome.gate,
    machineRead: outcome.machineRead,
  });
  await deps.drafts.confirm(draft!.id, confirmedAt, { autoLogged: false });
  return draft!.id;
}

/** Six realistic bills, one per day going back — the fixture the removed
 *  "seed" feature used to produce, kept here so the analytics/filter/export
 *  tests still have deterministic data through the real pipeline. */
const SAMPLE_TEXTS = [
  "wages 500 rajesh",
  "rent 2200 homebase",
  "internet 100 telstra gst",
  "electricity 340 origin gst",
  "supplies 145 officeworks gst",
  "materials 215 bunnings gst",
];

async function logSixSampleBills(): Promise<void> {
  for (let i = 0; i < SAMPLE_TEXTS.length; i++) {
    await logBill(SAMPLE_TEXTS[i]!, new Date(Date.now() - i * 86_400_000));
  }
}

async function get(app: ReturnType<typeof createApp>, path: string) {
  return app.request(path, { headers: AUTH_HEADER }, ENV);
}

describe("dev analytics dashboard (/dev/dashboard)", () => {
  beforeEach(() => resetDemo());

  it("returns 404 when DEV_DEMO is not set (never leaks to production)", async () => {
    const app = createApp();
    const res = await app.request("/dev/dashboard", {}, {});
    expect(res.status).toBe(404);
  });

  it("fails closed (500) when DEV_DEMO is on but no DASHBOARD_PASSWORD is configured", async () => {
    const app = createApp();
    const res = await app.request("/dev/dashboard", {}, { DEV_DEMO: "true" });
    expect(res.status).toBe(500);
  });

  it("rejects requests with no credentials", async () => {
    const app = createApp();
    const res = await app.request("/dev/dashboard", {}, ENV);
    expect(res.status).toBe(401);
  });

  it("rejects the wrong password", async () => {
    const app = createApp();
    const res = await app.request(
      "/dev/dashboard",
      { headers: { Authorization: "Basic " + btoa("billsnap:wrong-password") } },
      ENV,
    );
    expect(res.status).toBe(401);
  });

  it("serves the dashboard page when enabled", async () => {
    const app = createApp();
    const res = await get(app, "/dev/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BillSnap — dashboard");
    // Recent-bills table columns mirror the CSV export (F12 accountant share).
    expect(html).toContain(">Invoice</th>");
    expect(html).toContain(">ABN</th>");
  });

  it("reports empty analytics before any bill is logged", async () => {
    const app = createApp();
    const res = await get(app, "/dev/dashboard/data");
    const data = (await res.json()) as DashboardJson;
    expect(data.totals.count).toBe(0);
    expect(data.totals.amount).toBe(0);
    expect(data.categories).toEqual([]);
    expect(data.recent).toEqual([]);
  });

  it("aggregates six logged bills through the pipeline into clean analytics", async () => {
    const app = createApp();
    await logSixSampleBills();
    const d = await data(app);

    // 500 + 2200 + 100 + 340 + 145 + 215 = 3500; GST 10 + 34 + 14.50 + 21.50 = 80.
    expect(d.totals.count).toBe(6);
    expect(d.totals.amount).toBe(3500);
    expect(d.totals.gst).toBeCloseTo(80, 2);
    expect(d.totals.autoLogged).toBe(0); // regex entries are machine-read, never auto-logged
    expect(d.totals.manual).toBe(6);

    // Category breakdown, sorted by spend.
    expect(d.categories).toEqual([
      { category: "rent", count: 1, amount: 2200 },
      { category: "wages", count: 1, amount: 500 },
      { category: "utilities", count: 2, amount: 440 },
      { category: "inventory", count: 2, amount: 360 },
    ]);

    // GST markers stripped from the vendor names (regression: "telstra gst").
    expect(d.vendors.map((v) => v.vendor)).toEqual([
      "homebase",
      "rajesh",
      "origin",
      "bunnings",
      "officeworks",
      "telstra",
    ]);
    expect(d.vendors.every((v) => !v.vendor.includes("gst"))).toBe(true);

    // One bill per day going back → the 7-day chart has shape.
    expect(d.days).toHaveLength(7);
    expect(d.days.reduce((n, day) => n + day.count, 0)).toBe(6);

    // Newest confirmed first.
    const times = d.recent.map((r) => new Date(r.confirmedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(d.recent[0]?.vendor).toBe("rajesh");
  });

  it("lists the months present and echoes the active filters", async () => {
    const app = createApp();
    await logSixSampleBills();
    const d = await data(app);

    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(d.months).toEqual([currentMonth]);
    expect(d.filters).toEqual({ month: null, category: null, vendor: null });
    expect(d.categoryOptions).toEqual(["inventory", "rent", "utilities", "wages"]);
  });

  it("filters by month, category, and vendor (cascading)", async () => {
    const app = createApp();
    await logSixSampleBills();
    await logBill("wages 500 july-book", new Date("2026-07-15T00:00:00.000Z"));

    const all = await data(app);
    expect(all.months).toHaveLength(2);
    expect(all.totals.count).toBe(7);

    // Month scopes to July only.
    const july = await data(app, "?month=2026-07");
    expect(july.totals.count).toBe(1);
    expect(july.totals.amount).toBe(500);
    expect(july.filters.month).toBe("2026-07");
    // The options cascade: July has only the wages category.
    expect(july.categoryOptions).toEqual(["wages"]);
    expect(july.vendorOptions).toEqual(["july-book"]);

    // Category scopes to the utilities bills in the current month.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const utilities = await data(app, `?month=${currentMonth}&category=utilities`);
    expect(utilities.totals.count).toBe(2);
    expect(utilities.totals.amount).toBe(440);
    expect(utilities.vendorOptions).toEqual(["origin", "telstra"]);

    // Vendor narrows to a single bill.
    const origin = await data(app, `?month=${currentMonth}&category=utilities&vendor=origin`);
    expect(origin.totals.count).toBe(1);
    expect(origin.totals.amount).toBe(340);
    expect(origin.recent[0]?.vendor).toBe("origin");

    // A stale/impossible month is dropped → the all-time view (never a confusing empty dashboard).
    const none = await data(app, "?month=2020-01");
    expect(none.filters.month).toBeNull();
    expect(none.totals.count).toBe(7);
  });

  it("exports the filtered bill list as CSV for the accountant share", async () => {
    const app = createApp();
    await logSixSampleBills();
    await logBill("wages 500 july-book", new Date("2026-07-15T00:00:00.000Z"));

    // Gated like the rest of the dev dashboard.
    const gated = await app.request("/dev/dashboard/export.csv", {}, {});
    expect(gated.status).toBe(404);

    const res = await app.request("/dev/dashboard/export.csv?month=2026-07", { headers: AUTH_HEADER }, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain('filename="bills-2026-07.csv"');

    // The UTF-8 BOM is on the wire (text() decoders consume it — assert the raw bytes).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Logged,Bill date,Vendor,Vendor resolved to,Category,Amount,GST,GST basis,Invoice,ABN,Source,Gate");
    expect(lines).toHaveLength(2); // header + the single July bill
    expect(lines[1]).toContain("2026-07-15");
    expect(lines[1]).toContain("july-book");
    expect(lines[1]).toContain("500.00");

    // Unfiltered export carries every row (trailing CRLF trimmed first).
    const all = await app.request("/dev/dashboard/export.csv", { headers: AUTH_HEADER }, ENV);
    expect((await all.text()).trimEnd().split("\r\n").length).toBe(8); // header + 7 bills
  });

  it("quotes CSV fields containing commas or quotes and names files from filters", () => {
    const bill: LoggedBill = {
      id: "draft-1",
      confirmedAt: "2026-08-16T03:00:00.000Z",
      date: null,
      vendor: 'Acme, "Supa" Co',
      vendorResolvedTo: null,
      category: "misc",
      amount: 12.5,
      gst: null,
      gstBasis: null,
      invoiceNumber: null,
      abn: null,
      autoLogged: false,
    };
    const csv = billsToCsv(null, [bill]);
    expect(csv.slice(1)).toContain('"Acme, ""Supa"" Co"');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(exportFileName({ month: "2026-08", category: "utilities" })).toBe("bills-2026-08-utilities.csv");
    expect(exportFileName({})).toBe("bills.csv");
  });

  it("reflects bills confirmed and undone in the demo console", async () => {
    const app = createApp();
    await app.request("/dev/demo/photo", { method: "POST" }, ENV);
    await app.request("/dev/demo/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "1" }) }, ENV);

    const after = (await (await get(app, "/dev/dashboard/data")).json()) as DashboardJson;
    expect(after.totals.count).toBe(1);
    expect(after.totals.amount).toBe(0); // fixture bytes extract nothing

    await app.request("/dev/demo/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "delete" }) }, ENV);
    const undone = (await (await get(app, "/dev/dashboard/data")).json()) as DashboardJson;
    expect(undone.totals.count).toBe(0);
  });
});

describe("dev settings page (/dev/dashboard/settings)", () => {
  beforeEach(() => resetDemo());

  it("returns 404 when DEV_DEMO is not set", async () => {
    const app = createApp();
    const res = await app.request("/dev/dashboard/settings", {}, {});
    expect(res.status).toBe(404);
  });

  it("shows a business-not-found state before the demo phone is onboarded", async () => {
    const app = createApp();
    const html = await (await get(app, "/dev/dashboard/settings")).text();
    expect(html).toContain("No business found for this device");
  });

  it("shows company info, regular vendors (2+ bills), and the owner in team members", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    // Two Telstra bills clear the "regular vendor" threshold; a single
    // Bunnings bill should NOT appear (matches aggregateRegularVendors' bar).
    await logBill("internet 100 telstra gst", new Date());
    await logBill("internet 120 telstra gst", new Date(Date.now() - 86_400_000));
    await logBill("materials 50 bunnings gst", new Date(Date.now() - 2 * 86_400_000));

    const app = createApp();
    const html = await (await get(app, "/dev/dashboard/settings")).text();

    expect(html).toContain("My Business");
    expect(html).toMatch(/<td>[^<]*[Tt]elstra[^<]*<\/td><td class="num">2<\/td>/);
    expect(html).not.toMatch(/<td>[^<]*[Bb]unnings[^<]*<\/td>/);
    expect(html).toContain(DEMO_PHONE);
    expect(html).toContain("Owner");
  });

  it("saves company details and shows them back (+ a Saved banner via the redirect flag)", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    const app = createApp();

    const body = new URLSearchParams({
      name: "Acme Pty Ltd",
      abn: "12 345 678 901",
      gstNumber: "GST-9988",
      address: "1 Example St, Sydney NSW",
      phone: "0400 000 111",
      timezone: "Australia/Sydney",
      gstRegistered: "on",
      // autoSave intentionally omitted — unchecked checkboxes aren't submitted.
    });
    const res = await app.request(
      "/dev/dashboard/settings",
      { method: "POST", headers: { ...AUTH_HEADER, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
      ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dev/dashboard/settings?saved=1");

    const saved = await (await get(app, "/dev/dashboard/settings?saved=1")).text();
    expect(saved).toContain("Saved.");
    expect(saved).toContain("Acme Pty Ltd");
    expect(saved).toContain("GST-9988");
    expect(saved).toContain("1 Example St, Sydney NSW");
    expect(saved).toContain("0400 000 111");

    // The plain GET (no ?saved=1) reflects the same data without the banner.
    const plain = await (await get(app, "/dev/dashboard/settings")).text();
    expect(plain).not.toContain("Saved.");
    expect(plain).toContain("Acme Pty Ltd");
  });

  it("is a no-op when posted for a device with no business yet", async () => {
    const app = createApp();
    const res = await app.request(
      "/dev/dashboard/settings",
      { method: "POST", headers: { ...AUTH_HEADER, "content-type": "application/x-www-form-urlencoded" }, body: "name=Nope" },
      ENV,
    );
    expect(res.status).toBe(302); // still redirects — nothing to fail on
    const html = await (await get(app, "/dev/dashboard/settings")).text();
    expect(html).toContain("No business found for this device");
  });
});

describe("CSV export letterhead", () => {
  beforeEach(() => resetDemo());

  it("prepends the business's company details above the bill table", async () => {
    const deps = demoDeps(loadConfig(ENV));
    const { business } = await deps.businesses.onboard(DEMO_PHONE);
    await deps.businesses.updateBusiness(business.id, {
      name: "Acme Pty Ltd",
      abn: "12 345 678 901",
      gstNumber: "GST-9988",
    });
    await logBill("internet 100 telstra gst", new Date());

    const app = createApp();
    const res = await app.request("/dev/dashboard/export.csv", { headers: AUTH_HEADER }, ENV);
    const csv = await res.text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Acme Pty Ltd");
    expect(lines[1]).toBe("ABN: 12 345 678 901");
    expect(lines[2]).toBe("GST number: GST-9988");
    expect(lines.some((l) => l.startsWith("Exported: "))).toBe(true);
    expect(lines).toContain("Logged,Bill date,Vendor,Vendor resolved to,Category,Amount,GST,GST basis,Invoice,ABN,Source,Gate");
  });

  it("omits the letterhead when no business is onboarded", async () => {
    await logBill("internet 100 telstra gst", new Date());
    const app = createApp();
    const res = await app.request("/dev/dashboard/export.csv", { headers: AUTH_HEADER }, ENV);
    const csv = await res.text();
    expect(csv.trimEnd().split("\r\n")[0]).toBe(
      "Logged,Bill date,Vendor,Vendor resolved to,Category,Amount,GST,GST basis,Invoice,ABN,Source,Gate",
    );
  });
});

describe("admin bills table (/dev/dashboard/bills)", () => {
  beforeEach(() => resetDemo());

  it("shows a business-not-found state before the demo phone is onboarded", async () => {
    const app = createApp();
    const html = await (await get(app, "/dev/dashboard/bills")).text();
    expect(html).toContain("No business found for this device");
  });

  it("lists logged bills with edit/delete actions", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    await logBill("internet 100 telstra gst", new Date());

    const app = createApp();
    const html = await (await get(app, "/dev/dashboard/bills")).text();
    expect(html).toMatch(/<td>[^<]*[Tt]elstra[^<]*<\/td>/);
    expect(html).toContain("$100.00");
    expect(html).toContain(">utilities<");
    expect(html).toContain("/edit");
    expect(html).toContain("/delete");
  });

  it("edit form prefills the bill, and POST updates the table + downstream vendor memory", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    // Two Telstra bills clear the "regular vendor" threshold on the settings page.
    const idA = await logBillAs(DEMO_PHONE, "internet 100 telstra gst", new Date());
    await logBillAs(DEMO_PHONE, "internet 120 telstra gst", new Date(Date.now() - 60_000));

    const app = createApp();
    const settingsBefore = await (await get(app, "/dev/dashboard/settings")).text();
    expect(settingsBefore).toMatch(/<td>[^<]*[Tt]elstra[^<]*<\/td><td class="num">2<\/td>/);

    const editForm = await (await get(app, `/dev/dashboard/bills/${idA}/edit`)).text();
    expect(editForm).toContain('value="telstra"');
    expect(editForm).toContain('value="utilities" selected');

    const res = await app.request(
      `/dev/dashboard/bills/${idA}/edit`,
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          vendor: "Origin Energy",
          category: "utilities",
          amount: "150",
          gst: "13.64",
          date: "2026-08-20",
          invoiceNumber: "INV-9",
          abn: "12 345 678 901",
        }).toString(),
      },
      ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dev/dashboard/bills?flash=saved");

    const afterBills = await (await get(app, "/dev/dashboard/bills?flash=saved")).text();
    expect(afterBills).toContain("Bill updated.");
    expect(afterBills).toMatch(/<td>[^<]*Origin Energy[^<]*<\/td>/);
    expect(afterBills).toContain("$150.00");
    expect(afterBills).toContain("Edited");
    expect(afterBills).toContain("vendor:");

    // Recategorising bill A away from Telstra drops it below the 2-bill
    // "regular vendor" threshold — confirms updateLogged's denormalised
    // column write reached TransactionStore.getRegularVendors, not just
    // the raw_extraction copy the table itself reads.
    const settingsAfter = await (await get(app, "/dev/dashboard/settings")).text();
    expect(settingsAfter).not.toMatch(/<td>[^<]*[Tt]elstra[^<]*<\/td><td class="num">2<\/td>/);
  });

  it("delete removes the bill from the table and logs an audit entry", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    const id = await logBillAs(DEMO_PHONE, "internet 100 telstra gst", new Date());

    const app = createApp();
    const res = await app.request(`/dev/dashboard/bills/${id}/delete`, { method: "POST", headers: AUTH_HEADER }, ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dev/dashboard/bills?flash=deleted");

    const html = await (await get(app, "/dev/dashboard/bills?flash=deleted")).text();
    expect(html).toContain("Bill deleted.");
    expect(html).toContain("No bills logged yet.");
    expect(html).toContain("Deleted");
  });

  it("404s on cross-device edit/delete attempts", async () => {
    const deps = demoDeps(loadConfig(ENV));
    await deps.businesses.onboard(DEMO_PHONE);
    const id = await logBillAs(DEMO_PHONE, "internet 100 telstra gst", new Date());
    // A second device with its own, separate business.
    await deps.businesses.onboard("61499999999");

    const app = createApp();
    const editRes = await get(app, `/dev/dashboard/bills/${id}/edit?device=61499999999`);
    expect(editRes.status).toBe(404);

    const postRes = await app.request(
      `/dev/dashboard/bills/${id}/edit`,
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ device: "61499999999", vendor: "Hacked" }).toString(),
      },
      ENV,
    );
    expect(postRes.status).toBe(404);

    const deleteRes = await app.request(
      `/dev/dashboard/bills/${id}/delete`,
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/x-www-form-urlencoded" },
        body: "device=61499999999",
      },
      ENV,
    );
    expect(deleteRes.status).toBe(404);

    // Untouched.
    const html = await (await get(app, "/dev/dashboard/bills")).text();
    expect(html).toMatch(/<td>[^<]*[Tt]elstra[^<]*<\/td>/);
  });
});
