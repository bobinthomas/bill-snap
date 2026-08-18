import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { billsToCsv, exportFileName, type LoggedBill } from "../src/dev/dashboard";
import { demoDeps, DEMO_PHONE, resetDemo } from "../src/dev/demo";
import { createApp } from "../src/index";

const ENV = { DEV_DEMO: "true" };

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
  const res = await app.request("/dev/dashboard/data" + query, {}, ENV);
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardJson;
}

/** Log a single bill directly through the real stores with a fixed confirmedAt. */
async function logBill(text: string, confirmedAt: Date): Promise<void> {
  const deps = demoDeps(loadConfig(ENV));
  const outcome = await deps.extraction.run({ text });
  const draft = await deps.drafts.createDraft({
    userPhone: DEMO_PHONE,
    waMessageId: `wamid.test.${text}.${confirmedAt.getTime()}`,
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
}

async function get(app: ReturnType<typeof createApp>, path: string) {
  return app.request(path, {}, ENV);
}

describe("dev analytics dashboard (/dev/dashboard)", () => {
  beforeEach(() => resetDemo());

  it("returns 404 when DEV_DEMO is not set (never leaks to production)", async () => {
    const app = createApp();
    const res = await app.request("/dev/dashboard", {}, {});
    expect(res.status).toBe(404);
  });

  it("serves the dashboard page when enabled", async () => {
    const app = createApp();
    const res = await get(app, "/dev/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BillSnap — dashboard");
    expect(html).toContain("Seed sample bills");
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

  it("seed logs six realistic bills through the pipeline with clean analytics", async () => {
    const app = createApp();
    const seed = await app.request("/dev/dashboard/seed", { method: "POST" }, ENV);
    expect(seed.status).toBe(200);
    const data = (await seed.json()) as DashboardJson;

    // 500 + 2200 + 100 + 340 + 145 + 215 = 3500; GST 10 + 34 + 14.50 + 21.50 = 80.
    expect(data.totals.count).toBe(6);
    expect(data.totals.amount).toBe(3500);
    expect(data.totals.gst).toBeCloseTo(80, 2);
    expect(data.totals.autoLogged).toBe(0); // regex entries are machine-read, never auto-logged
    expect(data.totals.manual).toBe(6);

    // Category breakdown, sorted by spend.
    expect(data.categories).toEqual([
      { category: "rent", count: 1, amount: 2200 },
      { category: "wages", count: 1, amount: 500 },
      { category: "utilities", count: 2, amount: 440 },
      { category: "inventory", count: 2, amount: 360 },
    ]);

    // GST markers stripped from the vendor names (regression: "telstra gst").
    expect(data.vendors.map((v) => v.vendor)).toEqual([
      "homebase",
      "rajesh",
      "origin",
      "bunnings",
      "officeworks",
      "telstra",
    ]);
    expect(data.vendors.every((v) => !v.vendor.includes("gst"))).toBe(true);

    // One bill per day going back → the 7-day chart has shape.
    expect(data.days).toHaveLength(7);
    expect(data.days.reduce((n, d) => n + d.count, 0)).toBe(6);

    // Newest confirmed first.
    const times = data.recent.map((r) => new Date(r.confirmedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(data.recent[0]?.vendor).toBe("rajesh");
  });

  it("lists the months present and echoes the active filters", async () => {
    const app = createApp();
    await app.request("/dev/dashboard/seed", { method: "POST" }, ENV);
    const d = await data(app);

    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(d.months).toEqual([currentMonth]);
    expect(d.filters).toEqual({ month: null, category: null, vendor: null });
    expect(d.categoryOptions).toEqual(["inventory", "rent", "utilities", "wages"]);
  });

  it("filters by month, category, and vendor (cascading)", async () => {
    const app = createApp();
    await app.request("/dev/dashboard/seed", { method: "POST" }, ENV);
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
    await app.request("/dev/dashboard/seed", { method: "POST" }, ENV);
    await logBill("wages 500 july-book", new Date("2026-07-15T00:00:00.000Z"));

    // Gated like the rest of the dev dashboard.
    const gated = await app.request("/dev/dashboard/export.csv", {}, {});
    expect(gated.status).toBe(404);

    const res = await app.request("/dev/dashboard/export.csv?month=2026-07", {}, ENV);
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
    const all = await app.request("/dev/dashboard/export.csv", {}, ENV);
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
    const csv = billsToCsv([bill]);
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
