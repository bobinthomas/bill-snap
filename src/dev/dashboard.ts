/**
 * /dev/dashboard — analytics over a user's logged bills (DEV-only, gated by
 * config.devDemo like the /dev/demo console). Defaults to the demo user; the
 * webapp passes ?device= so the mobile flow's bills show up here too. Reads
 * the SAME store the flow writes to, so bills confirmed in the chat or the
 * webapp show up, and `seedDemoBills` logs a few realistic bills through the
 * real extraction pipeline so the analytics have data to show without typing.
 */
import type { AppConfig } from "../config";
import type { CloudBindings } from "../bindings";
import type { DraftRecord } from "../db/drafts";
import { mergeKnownVendors } from "../extraction/regex";
import { demoDeps, DEMO_PHONE } from "./demo";

export interface CategoryStat {
  category: string;
  count: number;
  amount: number;
}

export interface VendorStat {
  vendor: string;
  count: number;
  amount: number;
}

export interface DayStat {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  amount: number;
}

export interface LoggedBill {
  id: string;
  confirmedAt: string; // ISO
  date: string | null; // bill date from the extraction
  vendor: string | null;
  /** The known vendor a mangled reading was canonicalised to (§5.3 vendor
   *  cleanup) — lets the accountant see a name was machine-resolved, not read. */
  vendorResolvedTo: string | null;
  category: string;
  amount: number | null;
  gst: number | null;
  gstBasis: "inclusive" | "exclusive" | "none" | null;
  invoiceNumber: string | null;
  abn: string | null;
  autoLogged: boolean;
  gateLevel?: string;
}

export interface DashboardFilters {
  /** YYYY-MM; null/absent = all time. */
  month?: string;
  category?: string;
  vendor?: string;
}

export interface DashboardData {
  persistence: "d1" | "in-memory";
  /** Known-vendor list (seed + learned from this user's logged bills) that
   *  canonicalises mangled merchant names at extraction time. */
  knownVendors: string[];
  totals: { count: number; amount: number; gst: number; autoLogged: number; manual: number };
  categories: CategoryStat[];
  vendors: VendorStat[];
  /** Last 7 days (all-time view) or per-day within the selected month. */
  days: DayStat[];
  /** YYYY-MM keys present across ALL logged bills, newest first — the month selector. */
  months: string[];
  /** Cascading filter options at the current month level (for the selects). */
  categoryOptions: string[];
  /** Cascading filter options at the month+category level. */
  vendorOptions: string[];
  /** The active filters (echoed so the client can render the selects). */
  filters: { month: string | null; category: string | null; vendor: string | null };
  /** All bills in the filtered scope (export) — recent is the page's slice. */
  rows: LoggedBill[];
  recent: LoggedBill[];
}

/** Realistic fallback entries (regex path, §5.3) — the seed goes through the pipeline. */
const SEED_TEXTS = [
  "wages 500 rajesh",
  "rent 2200 homebase",
  "internet 100 telstra gst",
  "electricity 340 origin gst",
  "supplies 145 officeworks gst",
  "materials 215 bunnings gst",
];

/**
 * Log a few realistic bills, one per day going back, through the real
 * extraction + persistence path (createDraft → setFlowState → confirm). Each
 * run uses a fresh timestamp in the idempotency key, so clicking seed twice
 * doubles the data rather than erroring — it's a demo affordance.
 */
export async function seedDemoBills(config: AppConfig, bindings?: CloudBindings): Promise<void> {
  const deps = demoDeps(config, undefined, bindings);
  const stamp = Date.now();
  for (let i = 0; i < SEED_TEXTS.length; i++) {
    const text = SEED_TEXTS[i]!;
    const outcome = await deps.extraction.run({ text });
    const draft = await deps.drafts.createDraft({
      userPhone: DEMO_PHONE,
      waMessageId: `wamid.seed.${stamp}.${i}`,
      imageUrls: [],
      flowExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    if (!draft) continue; // idempotency guard — already seeded this message
    await deps.drafts.setFlowState(draft.id, {
      flowState: "awaiting_confirm",
      extraction: outcome.extraction,
      gateLevel: outcome.gate,
      machineRead: outcome.machineRead,
    });
    await deps.drafts.confirm(draft.id, new Date(Date.now() - i * 86_400_000), { autoLogged: false });
  }
}

const categoryOf = (b: DraftRecord) => b.extraction?.category_hint?.value ?? "misc";
const vendorOf = (b: DraftRecord) => b.extraction?.vendor.value ?? null;

/**
 * Analytics over the demo user's logged bills, scoped by cascading filters
 * (month → category → vendor). The options lists come from the level above the
 * active filter, so the selects narrow naturally; unknown filter values are
 * dropped rather than returning an empty view.
 */
export async function dashboardData(
  config: AppConfig,
  filters: DashboardFilters = {},
  bindings?: CloudBindings,
  userPhone: string = DEMO_PHONE,
): Promise<DashboardData> {
  const deps = demoDeps(config, undefined, bindings);
  const bills = await deps.drafts.listLogged(userPhone);

  const months = [...new Set(bills.map((b) => b.confirmedAt?.toISOString().slice(0, 7)))]
    .filter((m): m is string => m !== undefined)
    .sort()
    .reverse();
  const month = filters.month && months.includes(filters.month) ? filters.month : null;
  const byMonth = month
    ? bills.filter((b) => b.confirmedAt?.toISOString().slice(0, 7) === month)
    : bills;

  const categoryOptions = [...new Set(byMonth.map(categoryOf))].sort();
  const category = filters.category && categoryOptions.includes(filters.category) ? filters.category : null;
  const byCategory = category ? byMonth.filter((b) => categoryOf(b) === category) : byMonth;

  const vendorOptions = [...new Set(byCategory.map(vendorOf))]
    .filter((v): v is string => v !== null)
    .sort();
  const vendor = filters.vendor && vendorOptions.includes(filters.vendor) ? filters.vendor : null;
  const scoped = vendor ? byCategory.filter((b) => vendorOf(b) === vendor) : byCategory;

  let amount = 0;
  let gst = 0;
  let autoLogged = 0;
  const cats = new Map<string, { count: number; amount: number }>();
  const vendors = new Map<string, { count: number; amount: number }>();

  for (const b of scoped) {
    const a = b.extraction?.amount.value ?? null;
    const g = b.extraction?.gst.value ?? null;
    const vendorName = vendorOf(b);
    if (a !== null) {
      amount += a;
      const cat = categoryOf(b);
      const c = cats.get(cat) ?? { count: 0, amount: 0 };
      c.count += 1;
      c.amount += a;
      cats.set(cat, c);
      if (vendorName !== null) {
        const v = vendors.get(vendorName) ?? { count: 0, amount: 0 };
        v.count += 1;
        v.amount += a;
        vendors.set(vendorName, v);
      }
    }
    if (g !== null) gst += g;
    if (b.autoLogged) autoLogged += 1;
  }

  const byAmount = <T extends { amount: number }>(xs: T[]): T[] =>
    [...xs].sort((x, y) => y.amount - x.amount);

  // The same merge the webapp/demo extraction uses — seed + vendors learned
  // from logged bills, so the dashboard shows how the list grows.
  const knownVendors = mergeKnownVendors(bills.map((b) => b.extraction?.vendor.value ?? null));

  return {
    persistence: bindings?.db ? "d1" : "in-memory",
    knownVendors,
    totals: {
      count: scoped.length,
      amount,
      gst,
      autoLogged,
      manual: scoped.length - autoLogged,
    },
    categories: byAmount(
      [...cats.entries()].map(([category, c]) => ({ category, count: c.count, amount: c.amount })),
    ),
    vendors: byAmount(
      [...vendors.entries()].map(([vendor, v]) => ({ vendor, count: v.count, amount: v.amount })),
    ).slice(0, 8),
    days: month ? monthDays(month, scoped) : last7Days(scoped),
    months,
    categoryOptions,
    vendorOptions,
    filters: { month, category, vendor },
    rows: scoped.map(toLoggedBill),
    recent: scoped.slice(0, 20).map(toLoggedBill),
  };
}

/** Last 7 days, zero-filled — the default all-time view. */
function last7Days(bills: DraftRecord[]): DayStat[] {
  const days: DayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date: key, count: 0, amount: 0 });
  }
  return fillDays(days, bills);
}

/** Every day of the selected month, zero-filled. */
function monthDays(month: string, bills: DraftRecord[]): DayStat[] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const dayCount = new Date(y, m, 0).getDate(); // day 0 of month m+1 = last day of month m
  const days: DayStat[] = [];
  for (let d = 1; d <= dayCount; d++) {
    days.push({ date: `${month}-${String(d).padStart(2, "0")}`, count: 0, amount: 0 });
  }
  return fillDays(days, bills);
}

function fillDays(days: DayStat[], bills: DraftRecord[]): DayStat[] {
  for (const b of bills) {
    if (!b.confirmedAt) continue;
    const key = b.confirmedAt.toISOString().slice(0, 10);
    const day = days.find((d) => d.date === key);
    if (!day) continue;
    day.count += 1;
    const a = b.extraction?.amount.value ?? null;
    if (a !== null) day.amount += a;
  }
  return days;
}

function toLoggedBill(b: DraftRecord): LoggedBill {
  return {
    id: b.id,
    confirmedAt: (b.confirmedAt ?? b.createdAt).toISOString(),
    date: b.extraction?.date.value ?? null,
    vendor: b.extraction?.vendor.value ?? null,
    vendorResolvedTo: b.extraction?.vendor_resolved_to?.value ?? null,
    category: categoryOf(b),
    amount: b.extraction?.amount.value ?? null,
    gst: b.extraction?.gst.value ?? null,
    gstBasis: b.extraction?.gst_basis ?? null,
    invoiceNumber: b.extraction?.invoice_number.value ?? null,
    abn: b.extraction?.abn.value ?? null,
    autoLogged: b.autoLogged ?? false,
    gateLevel: b.gateLevel,
  };
}

/**
 * RFC-4180-style CSV for Excel/accounting tools: UTF-8 BOM (so Excel reads the
 * encoding and the currency symbols), CRLF line endings, fields containing
 * commas/quotes/newlines quoted with doubled quotes. Amounts are fixed to 2dp
 * so spreadsheet apps import them as numbers.
 */
export function billsToCsv(bills: LoggedBill[]): string {
  const header = [
    "Logged",
    "Bill date",
    "Vendor",
    "Vendor resolved to",
    "Category",
    "Amount",
    "GST",
    "GST basis",
    "Invoice",
    "ABN",
    "Source",
    "Gate",
  ];
  const body = bills.map((b) => [
    b.confirmedAt.slice(0, 10),
    b.date ?? "",
    b.vendor ?? "",
    b.vendorResolvedTo ?? "",
    b.category,
    b.amount === null ? "" : b.amount.toFixed(2),
    b.gst === null ? "" : b.gst.toFixed(2),
    b.gstBasis ?? "",
    b.invoiceNumber ?? "",
    b.abn ?? "",
    b.autoLogged ? "auto" : "manual",
    b.gateLevel ?? "",
  ]);
  const line = (row: string[]) => row.map(csvCell).join(",");
  return "\uFEFF" + [header, ...body].map(line).join("\r\n") + "\r\n";
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
}

/** Download filename from the active filters — e.g. bills-2026-08-utilities.csv. */
export function exportFileName(filters: DashboardFilters): string {
  const parts = ["bills"];
  const clean = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase();
  if (filters.month) parts.push(filters.month);
  if (filters.category) parts.push(clean(filters.category));
  if (filters.vendor) parts.push(clean(filters.vendor));
  return parts.join("-") + ".csv";
}

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b141a; color: #e9edef; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 12px 20px; background: #1f2c34; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header a { color: #00a884; font-size: 13px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  #badge { font-size: 12px; color: #8696a0; }
  main { max-width: 960px; margin: 0 auto; padding: 20px; }
  #cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { background: #1f2c34; border-radius: 10px; padding: 14px 16px; }
  .card .label { font-size: 12px; color: #8696a0; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .card .sub { font-size: 12px; color: #8696a0; margin-top: 2px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  section { background: #1f2c34; border-radius: 10px; padding: 16px; }
  section h2 { font-size: 13px; margin: 0 0 12px; color: #8696a0; text-transform: uppercase; letter-spacing: .04em; }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 70px; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
  .bar-row .name { text-align: right; color: #e9edef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { background: #2a3942; border-radius: 4px; height: 14px; overflow: hidden; }
  .bar-fill { background: #00a884; height: 100%; border-radius: 4px; }
  .bar-row .amt { text-align: right; color: #8696a0; }
  .days { display: flex; gap: 6px; align-items: flex-end; height: 120px; margin-top: 4px; }
  .day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .day .bar { width: 100%; background: #00a884; border-radius: 4px 4px 0 0; min-height: 2px; }
  .day .date { font-size: 10px; color: #8696a0; }
  .day .count { font-size: 11px; color: #e9edef; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a3942; }
  th { color: #8696a0; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .tag.auto { background: #123b2c; color: #00a884; }
  .tag.manual { background: #2a3942; color: #8696a0; }
  .tag.none { background: #2a3942; color: #8696a0; }
  #controls { margin: 12px 0; display: flex; gap: 8px; align-items: center; }
  #filters { margin: 0 0 12px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  #filters label { font-size: 12px; color: #8696a0; display: inline-flex; align-items: center; gap: 6px; }
  select { background: #2a3942; color: #e9edef; border: none; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  select:focus { outline: 1px solid #00a884; }
  button { background: #00a884; color: #0b141a; border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button.ghost { background: #2a3942; color: #e9edef; }
  .empty { color: #8696a0; font-size: 13px; padding: 12px 0; }
  #hint { font-size: 12px; color: #8696a0; margin-top: 16px; }
  code { color: #ffa657; }
</style>
</head>
<body>
  <header>
    <h1>BillSnap — dashboard</h1>
    <span id="badge"></span>
    <span id="known"></span>
    <a href="/dev/demo">💬 Demo console</a>
    <a href="/">🏠 Landing</a>
  </header>
  <main>
    <div id="controls">
      <button id="seed">✨ Seed sample bills</button>
      <button id="refresh" class="ghost">Refresh</button>
      <button id="export" class="ghost">⬇️ Export CSV</button>
    </div>
    <div id="filters">
      <label>Month <select id="f-month"></select></label>
      <label>Category <select id="f-category"></select></label>
      <label>Vendor <select id="f-vendor"></select></label>
    </div>
    <div id="cards"></div>
    <div class="cols">
      <section><h2>By category</h2><div id="cats"></div></section>
      <section><h2>Top vendors</h2><div id="vendors"></div></section>
    </div>
    <section style="margin-top:12px;"><h2 id="days-title">Last 7 days</h2><div id="days"></div></section>
    <section style="margin-top:12px;"><h2>Recent bills</h2><div id="recent"></div></section>
    <div id="hint">Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. <code>seed</code> logs a week of realistic bills through the real extraction pipeline. Persistence is in-memory until local D1 is configured (<code>npm run dev:full</code>).</div>
  </main>
<script>
  const $ = (id) => document.getElementById(id);
  function money(n) { return n === null ? "—" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function bars(list, total) {
    if (!list.length) return '<div class="empty">No bills yet — send a photo in the demo console or hit ✨ Seed.</div>';
    return list.map((x) => {
      const pct = total > 0 ? Math.max(3, Math.round((x.amount / total) * 100)) : 0;
      return '<div class="bar-row"><span class="name" title="' + esc(x.category || x.vendor) + '">' + esc(x.category || x.vendor) + "</span>" +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="amt">' + money(x.amount) + " · " + x.count + "</span></div>";
    }).join("");
  }
  function days(ds, monthView) {
    const max = Math.max(1, ...ds.map((d) => d.count));
    const label = (d) => monthView ? d.date.slice(8) : d.date.slice(5);
    return '<div class="days">' + ds.map((d) =>
      '<div class="day"><div class="bar" style="height:' + Math.max(4, (d.count / max) * 100) + '%"></div>' +
      '<span class="count">' + (d.count || "") + '</span><span class="date">' + label(d) + "</span></div>"
    ).join("") + "</div>";
  }
  function table(bills) {
    if (!bills.length) return '<div class="empty">Nothing logged yet.</div>';
    return "<table><thead><tr><th>Logged</th><th>Bill date</th><th>Vendor</th><th>Category</th>" +
      '<th class="num">Amount</th><th class="num">GST</th><th>Invoice</th><th>ABN</th><th>Source</th></tr></thead><tbody>' +
      bills.map((b) => {
        const when = new Date(b.confirmedAt).toISOString().slice(0, 10);
        const tag = b.autoLogged ? '<span class="tag auto">auto</span>' : '<span class="tag manual">manual</span>';
    const resolved = b.vendorResolvedTo
      ? ' <span class="tag manual" title="canonicalised from a mangled OCR reading to a known merchant">resolved</span>'
      : "";
    return "<tr><td>" + when + "</td><td>" + esc(b.date || "—") + "</td><td>" + esc(b.vendor || "—") + resolved + "</td><td>" +
      esc(b.category) + '</td><td class="num">' + money(b.amount) + '</td><td class="num">' + money(b.gst) +
      "</td><td>" + esc(b.invoiceNumber || "—") + "</td><td>" + esc(b.abn || "—") + "</td><td>" + tag + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function render(d) {
    $("badge").textContent = "persistence: " + d.persistence + " · " + d.totals.count + " logged" + (d.filters.month ? " · " + d.filters.month : "");
    const known = (d.knownVendors || []).filter((v) => !/^(telstra|origin energy|bunnings|caltex|homebase|rajesh|reliance hypermart limited|hdfc bank|gujarat freight tools)$/i.test(v));
    $("known").textContent = known.length ? "🧠 learned vendors: " + known.join(", ") : "";
    $("known").style.color = "#00a884";
    $("known").style.fontSize = "12px";
    $("hint").innerHTML = d.persistence === "d1"
      ? 'Bills confirmed in the <a href="/dev/demo">demo console</a> are written to the local D1 store — they survive page reloads. <code>seed</code> logs a week of realistic bills through the real extraction pipeline.'
      : 'Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. <code>seed</code> logs a week of realistic bills. Persistence is in-memory — start <code>npm run dev:full</code> (local D1 + R2) and demo entries will survive reloads.';
    $("cards").innerHTML = [
      ["Bills logged", d.totals.count, ""],
      ["Total spend", money(d.totals.amount), ""],
      ["Total GST", money(d.totals.gst), ""],
      ["Auto-logged", d.totals.autoLogged + " of " + d.totals.count, d.totals.autoLogged ? "24 h undo window" : ""],
    ].map((c) => '<div class="card"><div class="label">' + c[0] + '</div><div class="value">' + c[1] + '</div><div class="sub">' + c[2] + "</div></div>").join("");
    $("cats").innerHTML = bars(d.categories, d.totals.amount);
    $("vendors").innerHTML = bars(d.vendors, d.totals.amount);
    $("days-title").textContent = d.filters.month
      ? new Date(Number(d.filters.month.slice(0, 4)), Number(d.filters.month.slice(5, 7)) - 1, 1)
          .toLocaleString("en-AU", { month: "long", year: "numeric" }) + " — daily"
      : "Last 7 days";
    $("days").innerHTML = days(d.days, d.filters.month !== null);
    $("recent").innerHTML = table(d.recent);
  }
  function fillSelect(id, label, values, current) {
    const el = $(id);
    el.innerHTML = '<option value="">' + label + "</option>" + values.map((v) =>
      '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>"
    ).join("");
  }
  function populate(d) {
    fillSelect("f-month", "All months", d.months, d.filters.month);
    fillSelect("f-category", "All categories", d.categoryOptions, d.filters.category);
    fillSelect("f-vendor", "All vendors", d.vendorOptions, d.filters.vendor);
  }
  function currentParams() {
    const p = new URLSearchParams();
    const m = $("f-month").value, c = $("f-category").value, v = $("f-vendor").value;
    if (m) p.set("month", m);
    if (c) p.set("category", c);
    if (v) p.set("vendor", v);
    // Carry the device scope from the page URL (the webapp links here with
    // ?device=) so the data fetch sees the same user the page was opened for.
    const dev = new URLSearchParams(location.search).get("device");
    if (dev) p.set("device", dev);
    return p;
  }
  async function refresh() {
    const q = currentParams().toString();
    const res = await fetch("/dev/dashboard/data" + (q ? "?" + q : ""));
    if (res.ok) { const d = await res.json(); render(d); populate(d); }
  }
  ["f-month", "f-category", "f-vendor"].forEach((id) => { $(id).onchange = refresh; });
  $("seed").onclick = async () => { await fetch("/dev/dashboard/seed", { method: "POST" }); await refresh(); };
  $("refresh").onclick = refresh;
  $("export").onclick = () => {
    const q = currentParams().toString();
    const a = document.createElement("a");
    a.href = "/dev/dashboard/export.csv" + (q ? "?" + q : "");
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;

export function renderDashboardPage(): string {
  return DASHBOARD_PAGE;
}
