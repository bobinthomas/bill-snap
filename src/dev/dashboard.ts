/**
 * /dev/dashboard — analytics over a user's logged bills (DEV-only, gated by
 * config.devDemo like the /dev/demo console). Defaults to the demo user; the
 * webapp passes ?device= so the mobile flow's bills show up here too. Reads
 * the SAME store the flow writes to, so bills confirmed in the chat or the
 * webapp show up.
 */
import type { AppConfig } from "../config";
import type { CloudBindings } from "../bindings";
import type { BusinessRecord } from "../db/businesses";
import type { DraftRecord } from "../db/drafts";
import { mergeKnownVendors } from "../extraction/regex";
import { resolveBusiness } from "../flows/helpers";
import { demoDeps, DEMO_PHONE } from "./demo";
import { iconBarChart, iconCheckCircle, iconDownload, iconHome, iconReceipt, iconRefresh, iconSettings, iconTag } from "./icons";
import { BASE_STYLES } from "./theme";
import { PREMIUM_FONTS, PREMIUM_REVEAL_SCRIPT, PREMIUM_STYLES } from "./theme-premium";

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
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 40px; }
  .eyebrow { margin-bottom: 18px; }
  .known-vendors { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 14px; min-height: 24px; }
  .known-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); font-weight: 700; margin-right: 2px; }
  .toolbar { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  .toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 12px; color: var(--text-faint); display: inline-flex; align-items: center; gap: 6px; }
  /* --- KPI bento: "Total spend" is the featured tile, spanning two columns.
     5 columns (not 4) so the 4 cards — 1 + 2 + 1 + 1 — fill exactly one row
     instead of the last card wrapping with 3 empty columns beside it. --- */
  .kpi-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
  .kpi-card {
    background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius-lg);
    padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  }
  .kpi-card:nth-child(2) { grid-column: span 2; }
  .kpi-card .kpi-icon {
    display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-text);
    border: 1px solid var(--accent-border);
  }
  .kpi-card .kpi-icon .icon { width: 15px; height: 15px; }
  .kpi-card .label { font-size: 11.5px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .kpi-card .value { font-family: var(--font-display); font-size: 27px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi-card:nth-child(2) .value { font-family: var(--font-numeral); font-size: 32px; font-weight: 700; letter-spacing: -0.01em; }
  .kpi-card .sub { font-size: 11.5px; color: var(--text-faint); }
  @media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpi-card:nth-child(2) { grid-column: span 2; } }
  @media (max-width: 480px) { .kpi-grid { grid-template-columns: 1fr; } .kpi-card:nth-child(2) { grid-column: span 1; } .kpi-card:nth-child(2) .value { font-size: 27px; } }
  /* --- bento split: category takes more room than the vendor list --- */
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 14px; margin-top: 4px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 76px; align-items: center; gap: 10px; margin-bottom: 9px; font-size: 12.5px; }
  .bar-row .name { text-align: right; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { background: var(--surface-3); border-radius: 4px; height: 8px; overflow: hidden; }
  .bar-fill { background: var(--accent); height: 100%; border-radius: 4px; }
  .bar-row .amt { text-align: right; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .days-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 4px; }
  .days { display: flex; gap: 6px; align-items: flex-end; height: 120px; }
  .day { flex: 1; min-width: 20px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .day .bar { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; }
  .day .date { font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .day .count { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
  th { color: var(--text-faint); font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  tbody tr:hover td { background: var(--surface-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .hint { margin-top: 16px; }

  /* --- mobile: stack the toolbar, widen tap targets, keep everything in-frame --- */
  @media (max-width: 720px) {
    main { padding: 14px 12px; }
    .toolbar { flex-direction: column; align-items: stretch; gap: 10px; }
    .toolbar-actions .btn { flex: 1 1 auto; justify-content: center; }
    .filters { flex-direction: column; align-items: stretch; gap: 8px; }
    .filters label { width: 100%; }
    .filters select { flex: 1; min-width: 0; }
    .btn, select { min-height: 40px; }
  }
  @media (max-width: 420px) {
    .bar-row { grid-template-columns: 72px 1fr 56px; gap: 6px; font-size: 11.5px; }
    th, td { padding: 8px; font-size: 11.5px; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconBarChart}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Dashboard</div></div>
    </div>
    <nav class="topbar-nav">
      <a id="settings-link" class="nav-link" href="/dev/dashboard/settings">${iconSettings} Settings</a>
      <a class="nav-link" href="/">${iconHome} Landing</a>
    </nav>
    <div class="topbar-status"><span id="badge" class="status-badge"></span></div>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Live analytics</span>
    <div id="known" class="known-vendors"></div>
    <div class="toolbar" data-reveal>
      <div class="toolbar-actions">
        <button id="refresh" class="btn btn-ghost">${iconRefresh}<span>Refresh</span></button>
        <button id="export" class="btn btn-primary"><span class="icon-chip">${iconDownload}</span><span>Export CSV</span></button>
      </div>
      <div id="filters" class="filters">
        <label>Month <select id="f-month"></select></label>
        <label>Category <select id="f-category"></select></label>
        <label>Vendor <select id="f-vendor"></select></label>
      </div>
    </div>
    <div id="cards" class="kpi-grid" data-reveal></div>
    <div class="cols" data-reveal>
      <section class="panel"><div class="panel-inner"><h2>By category</h2><div id="cats"></div></div></section>
      <section class="panel"><div class="panel-inner"><h2>Top vendors</h2><div id="vendors"></div></div></section>
    </div>
    <section class="panel" style="margin-top:14px;" data-reveal><div class="panel-inner"><h2 id="days-title">Last 7 days</h2><div class="days-scroll"><div id="days"></div></div></div></section>
    <section class="panel" style="margin-top:14px;" data-reveal><div class="panel-inner"><h2>Recent bills</h2><div id="recent"></div></div></section>
    <p id="hint" class="hint">Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. Persistence is in-memory until local D1 is configured (<code>npm run dev:full</code>).</p>
  </main>
<script>
  const $ = (id) => document.getElementById(id);
  function money(n) { return n === null ? "—" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function chip(text, variant) {
    const cls = "chip" + (variant ? " chip-" + variant : "");
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }
  function bars(list, total) {
    if (!list.length) return '<div class="empty">No bills yet — send a photo in the demo console.</div>';
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
    return '<div class="table-scroll"><table><thead><tr><th>Logged</th><th>Bill date</th><th>Vendor</th><th>Category</th>' +
      '<th class="num">Amount</th><th class="num">GST</th><th>Invoice</th><th>ABN</th><th>Source</th></tr></thead><tbody>' +
      bills.map((b) => {
        const when = new Date(b.confirmedAt).toISOString().slice(0, 10);
        const tag = b.autoLogged ? chip("auto", "success") : chip("manual");
    const resolved = b.vendorResolvedTo
      ? " " + '<span title="canonicalised from a mangled OCR reading to a known merchant">' + chip("resolved") + "</span>"
      : "";
    return "<tr><td>" + when + "</td><td>" + esc(b.date || "—") + "</td><td>" + esc(b.vendor || "—") + resolved + "</td><td>" +
      esc(b.category) + '</td><td class="num">' + money(b.amount) + '</td><td class="num">' + money(b.gst) +
      "</td><td>" + esc(b.invoiceNumber || "—") + "</td><td>" + esc(b.abn || "—") + "</td><td>" + tag + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function render(d) {
    $("badge").innerHTML = chip(d.persistence === "d1" ? "D1 + R2" : "in-memory") +
      chip(d.totals.count + " logged") +
      (d.filters.month ? chip(d.filters.month, "accent") : "");
    const known = (d.knownVendors || []).filter((v) => !/^(telstra|origin energy|bunnings|caltex|homebase|rajesh|reliance hypermart limited|hdfc bank|gujarat freight tools)$/i.test(v));
    $("known").innerHTML = known.length
      ? '<span class="known-label">Learned vendors</span>' + known.map((v) => chip(v, "accent")).join("")
      : "";
    $("hint").innerHTML = d.persistence === "d1"
      ? 'Bills confirmed in the <a href="/dev/demo">demo console</a> are written to the local D1 store — they survive page reloads.'
      : 'Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. Persistence is in-memory — start <code>npm run dev:full</code> (local D1 + R2) and demo entries will survive reloads.';
    $("cards").innerHTML = [
      ['${iconReceipt}', "Bills logged", d.totals.count, ""],
      ['${iconBarChart}', "Total spend", money(d.totals.amount), ""],
      ['${iconTag}', "Total GST", money(d.totals.gst), ""],
      ['${iconCheckCircle}', "Auto-logged", d.totals.autoLogged + " of " + d.totals.count, d.totals.autoLogged ? "24 h undo window" : ""],
    ].map((c) => '<div class="kpi-card"><span class="kpi-icon">' + c[0] + '</span><div><div class="label">' + c[1] + '</div><div class="value">' + c[2] + '</div><div class="sub">' + c[3] + "</div></div></div>").join("");
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
  // Carry the same device scope into Settings so it shows this business, not the demo one.
  (function () {
    const dev = new URLSearchParams(location.search).get("device");
    if (dev) $("settings-link").href = "/dev/dashboard/settings?device=" + encodeURIComponent(dev);
  })();
  async function refresh() {
    const q = currentParams().toString();
    const res = await fetch("/dev/dashboard/data" + (q ? "?" + q : ""));
    if (res.ok) { const d = await res.json(); render(d); populate(d); }
  }
  ["f-month", "f-category", "f-vendor"].forEach((id) => { $(id).onchange = refresh; });
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
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;

export function renderDashboardPage(): string {
  return DASHBOARD_PAGE;
}

/** Fetches the business behind `device` (default the demo phone) for the settings page. */
export async function dashboardBusiness(
  config: AppConfig,
  bindings?: CloudBindings,
  userPhone: string = DEMO_PHONE,
): Promise<BusinessRecord | null> {
  const deps = demoDeps(config, undefined, bindings);
  return resolveBusiness(deps, userPhone);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Settings page — basic company info, pre-filled and read for now. Not wired
 * to a save endpoint yet (BusinessPatch/updateBusiness already exist in
 * db/businesses.ts for when it is).
 */
export function renderDashboardSettingsPage(business: BusinessRecord | null, device?: string): string {
  const name = business ? escapeHtml(business.name) : "";
  const abn = business?.abn ? escapeHtml(business.abn) : "";
  const timezone = business ? escapeHtml(business.timezone) : "";
  const gstChecked = business?.gstRegistered ? " checked" : "";
  const autoSaveChecked = business?.autoSave ? " checked" : "";
  const dashboardHref = device ? `/dev/dashboard?device=${encodeURIComponent(device)}` : "/dev/dashboard";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — settings</title>
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 640px; margin: 0 auto; padding: 28px 20px 40px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .field label { font-size: 12.5px; font-weight: 600; color: var(--text-dim); }
  .field .text-input { width: 100%; }
  .field-check { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .field-check input { width: 16px; height: 16px; accent-color: var(--accent-solid); }
  .field-check label { font-size: 13px; color: var(--text); }
  .hint { margin-top: 14px; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconSettings}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Settings</div></div>
    </div>
    <nav class="topbar-nav">
      <a class="nav-link" href="${dashboardHref}">${iconBarChart} Dashboard</a>
      <a class="nav-link" href="/">${iconHome} Landing</a>
    </nav>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Company details</span>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Basic information</h2>
        ${
          business
            ? `<div class="field"><label for="s-name">Company name</label><input id="s-name" class="text-input" type="text" value="${name}" /></div>
        <div class="field"><label for="s-abn">ABN</label><input id="s-abn" class="text-input" type="text" placeholder="Not set" value="${abn}" /></div>
        <div class="field"><label for="s-timezone">Timezone</label><input id="s-timezone" class="text-input" type="text" value="${timezone}" /></div>
        <div class="field-check"><input id="s-gst" type="checkbox"${gstChecked} /><label for="s-gst">GST registered</label></div>
        <div class="field-check"><input id="s-autosave" type="checkbox"${autoSaveChecked} /><label for="s-autosave">Auto-save high-confidence bills</label></div>
        <button class="btn btn-primary" disabled>Save changes</button>`
            : `<div class="empty">No business found for this device yet — send a bill first.</div>`
        }
      </div>
    </section>
    <p class="hint">Not wired up yet — these fields aren't saved.</p>
  </main>
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;
}
